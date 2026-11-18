import type { Logger } from '@/actions/logger';
import type { PullRequestSnapshot } from '@/domain/pull-request';
import { err, ok, type Result } from '@/result';

import type { GitError, GitOutput, GitRunOptions, GitRunner } from './command';
import { type TempDirError, withTempDir } from './tmpdir';

export const FETCH_DEPTH = '10';
export const REBASE_TIMEOUT_MS = 5 * 60_000;

export type RebaseError =
  | GitError
  | TempDirError
  | { readonly kind: 'head_repo_missing' }
  | { readonly kind: 'head_changed'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'no_common_ancestor' }
  | { readonly kind: 'timeout' };

export interface RebaseDeps {
  readonly git: GitRunner;
  readonly logger: Logger;
  readonly now: () => number;
  readonly cloneUrl: (repoFullName: string) => string;
}

async function runGit(
  deps: RebaseDeps,
  dir: string,
  args: readonly string[],
  deadline: number,
  options: GitRunOptions = {},
): Promise<Result<GitOutput, RebaseError>> {
  const remaining = deadline - deps.now();
  if (remaining <= 0) return err({ kind: 'timeout' });

  const result = await deps.git.run(dir, args, { ...options, timeoutMs: remaining });
  if (result.ok) return result;

  return result.error.kind === 'timed_out' ? err({ kind: 'timeout' }) : result;
}

async function mergeBasePair(
  deps: RebaseDeps,
  dir: string,
  left: string,
  right: string,
  deadline: number,
): Promise<Result<string | null, RebaseError>> {
  const result = await runGit(deps, dir, ['merge-base', left, right], deadline, {
    allowedExitCodes: [0, 1],
  });
  if (!result.ok) return result;

  return ok(result.value.exitCode === 1 ? null : result.value.stdout || null);
}

async function mergeBase(
  deps: RebaseDeps,
  dir: string,
  refs: readonly string[],
  deadline: number,
): Promise<Result<string | null, RebaseError>> {
  const first = refs[0];
  if (first == null)
    return err({
      kind: 'unexpected_exit',
      command: 'git merge-base',
      exitCode: 1,
      stderr: 'empty refs',
    });

  let current = first;

  for (const ref of refs.slice(1)) {
    const pair = await mergeBasePair(deps, dir, current, ref, deadline);
    if (!pair.ok || pair.value == null) return pair;
    current = pair.value;
  }

  return ok(current);
}

async function mergeCommits(
  deps: RebaseDeps,
  dir: string,
  ref: string,
  deadline: number,
): Promise<Result<readonly (readonly string[])[], RebaseError>> {
  const result = await runGit(deps, dir, ['rev-list', '--parents', `${ref}..HEAD`], deadline);
  if (!result.ok) return result;

  return ok(
    result.value.stdout
      .split('\n')
      .map((line) => line.split(' ').slice(1))
      .filter((parents) => parents.length > 1),
  );
}

async function findEarliestBase(
  deps: RebaseDeps,
  dir: string,
  ref: string,
  deadline: number,
): Promise<Result<string | null, RebaseError>> {
  const base = await mergeBase(deps, dir, ['HEAD', ref], deadline);
  if (!base.ok) return base;

  if (base.value == null) return ok(null);

  const commits = await mergeCommits(deps, dir, ref, deadline);
  if (!commits.ok) return commits;

  const parents = [...new Set(commits.value.flat())];
  const parentResults = await Promise.all(
    parents.map((parent) => mergeBase(deps, dir, [parent, ref], deadline)),
  );
  const errors = parentResults.flatMap((result) => (result.ok ? [] : [result.error]));
  const firstError = errors[0];
  if (firstError != null) return err(firstError);

  if (parentResults.some((result) => result.ok && result.value == null)) return ok(null);

  const bases = parentResults.flatMap((result) =>
    result.ok && result.value != null ? [result.value] : [],
  );
  const uniqueBases = [...new Set([base.value, ...bases])];

  return mergeBase(deps, dir, uniqueBases, deadline);
}

async function isShallow(
  deps: RebaseDeps,
  dir: string,
  deadline: number,
): Promise<Result<boolean, RebaseError>> {
  const result = await runGit(deps, dir, ['rev-parse', '--is-shallow-repository'], deadline);
  if (!result.ok) return result;

  return ok(result.value.stdout !== 'false');
}

export async function fetchUntilMergeBase(
  deps: RebaseDeps,
  dir: string,
  baseBranch: string,
  headBranch: string,
  deadline: number,
): Promise<Result<string, RebaseError>> {
  const baseRef = `refs/remotes/origin/${baseBranch}`;
  const headRef = `refs/remotes/origin/${headBranch}`;

  while (deps.now() < deadline) {
    const common = await findEarliestBase(deps, dir, baseRef, deadline);
    if (!common.ok) return common;

    if (common.value != null) return ok(common.value);

    const shallow = await isShallow(deps, dir, deadline);
    if (!shallow.ok) return shallow;
    if (!shallow.value) return err({ kind: 'no_common_ancestor' });

    // The clone's shallow boundary can cut the head branch's ancestry just as
    // the base fetch can cut the base's, so both sides must be deepened.
    const deepen = await runGit(
      deps,
      dir,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--deepen',
        FETCH_DEPTH,
        'origin',
        `${baseBranch}:${baseRef}`,
        `+refs/heads/${headBranch}:${headRef}`,
      ],
      deadline,
    );
    if (!deepen.ok) return deepen;
  }

  return err({ kind: 'timeout' });
}

export async function rebaseOntoBase(
  deps: RebaseDeps,
  pullRequest: PullRequestSnapshot,
): Promise<Result<string | null, RebaseError>> {
  const repoFullName = pullRequest.head.repoFullName;
  if (repoFullName == null) return err({ kind: 'head_repo_missing' });

  const deadline = deps.now() + REBASE_TIMEOUT_MS;

  return withTempDir(async (dir) => {
    const clone = await runGit(
      deps,
      '.',
      [
        'clone',
        '--quiet',
        '--no-tags',
        '--branch',
        pullRequest.head.ref,
        '--depth',
        FETCH_DEPTH,
        deps.cloneUrl(repoFullName),
        dir,
      ],
      deadline,
      { redactedCommand: 'git clone' },
    );
    if (!clone.ok) return clone;

    const fetch = await runGit(
      deps,
      dir,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth',
        FETCH_DEPTH,
        'origin',
        `${pullRequest.base.ref}:refs/remotes/origin/${pullRequest.base.ref}`,
      ],
      deadline,
    );
    if (!fetch.ok) return fetch;

    const base = await fetchUntilMergeBase(
      deps,
      dir,
      pullRequest.base.ref,
      pullRequest.head.ref,
      deadline,
    );
    if (!base.ok) return base;

    const head = await runGit(deps, dir, ['show-ref', '--head', '-s', '/HEAD'], deadline);
    if (!head.ok) return head;

    if (head.value.stdout !== pullRequest.head.sha)
      return err({
        kind: 'head_changed',
        expected: pullRequest.head.sha,
        actual: head.value.stdout,
      });

    const onto = await runGit(
      deps,
      dir,
      ['show-ref', '-s', `refs/remotes/origin/${pullRequest.base.ref}`],
      deadline,
    );
    if (!onto.ok) return onto;

    deps.logger.info(`Rebasing ${pullRequest.head.ref} onto ${pullRequest.base.ref}`);
    const rebase = await runGit(
      deps,
      dir,
      ['rebase', '--quiet', '--autosquash', onto.value.stdout],
      deadline,
    );
    if (!rebase.ok) return rebase;

    const newHead = await runGit(deps, dir, ['show-ref', '--head', '-s', '/HEAD'], deadline);
    if (!newHead.ok) return newHead;

    if (newHead.value.stdout === head.value.stdout) {
      deps.logger.info(`Already up to date: ${pullRequest.head.ref}`);
      return ok(null);
    }

    const push = await runGit(
      deps,
      dir,
      ['push', '--quiet', '--force-with-lease', 'origin', pullRequest.head.ref],
      deadline,
    );
    if (!push.ok) return push;

    deps.logger.info(
      `Updated ${pullRequest.head.ref}: ${head.value.stdout} -> ${newHead.value.stdout}`,
    );
    return ok(newHead.value.stdout);
  });
}
