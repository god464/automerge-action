import type { Logger } from '@/actions/logger';
import { type PullRequestSnapshot, repoFullName, sameRepo } from '@/domain/pull-request';
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

async function deepen(
  deps: RebaseDeps,
  dir: string,
  baseRemote: string,
  baseSpec: string,
  headSpec: string,
  deadline: number,
): Promise<Result<void, RebaseError>> {
  if (baseRemote === 'origin') {
    const result = await runGit(
      deps,
      dir,
      ['fetch', '--quiet', '--no-tags', '--deepen', FETCH_DEPTH, 'origin', baseSpec, headSpec],
      deadline,
    );
    return result.ok ? ok(undefined) : result;
  }

  const base = await runGit(
    deps,
    dir,
    ['fetch', '--quiet', '--no-tags', '--deepen', FETCH_DEPTH, baseRemote, baseSpec],
    deadline,
  );
  if (!base.ok) return base;

  const head = await runGit(
    deps,
    dir,
    ['fetch', '--quiet', '--no-tags', '--deepen', FETCH_DEPTH, 'origin', headSpec],
    deadline,
  );
  return head.ok ? ok(undefined) : head;
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
  baseRemote: string,
  baseBranch: string,
  headBranch: string,
  deadline: number,
): Promise<Result<string, RebaseError>> {
  const baseRef = `refs/remotes/${baseRemote}/${baseBranch}`;
  const headRef = `refs/remotes/origin/${headBranch}`;

  while (deps.now() < deadline) {
    const common = await mergeBasePair(deps, dir, 'HEAD', baseRef, deadline);
    if (!common.ok) return common;

    if (common.value != null) return ok(common.value);

    const shallow = await isShallow(deps, dir, deadline);
    if (!shallow.ok) return shallow;
    if (!shallow.value) return err({ kind: 'no_common_ancestor' });

    // The clone's shallow boundary can cut the head branch's ancestry just as
    // the base fetch can cut the base's, so both sides must be deepened.
    const baseSpec = `${baseBranch}:${baseRef}`;
    const headSpec = `+refs/heads/${headBranch}:${headRef}`;
    const deepened = await deepen(deps, dir, baseRemote, baseSpec, headSpec, deadline);
    if (!deepened.ok) return deepened;
  }

  return err({ kind: 'timeout' });
}

export async function rebaseOntoBase(
  deps: RebaseDeps,
  pullRequest: PullRequestSnapshot,
): Promise<Result<string | null, RebaseError>> {
  const headRepo = pullRequest.head.repo;
  if (headRepo == null) return err({ kind: 'head_repo_missing' });

  const baseRepo = pullRequest.repo;
  const baseRemote = sameRepo(headRepo, baseRepo) ? 'origin' : 'base';
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
        deps.cloneUrl(repoFullName(headRepo)),
        dir,
      ],
      deadline,
      { redactedCommand: 'git clone' },
    );
    if (!clone.ok) return clone;

    if (baseRemote !== 'origin') {
      const addRemote = await runGit(
        deps,
        dir,
        ['remote', 'add', 'base', deps.cloneUrl(repoFullName(baseRepo))],
        deadline,
      );
      if (!addRemote.ok) return addRemote;
    }

    const fetch = await runGit(
      deps,
      dir,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth',
        FETCH_DEPTH,
        baseRemote,
        `${pullRequest.base.ref}:refs/remotes/${baseRemote}/${pullRequest.base.ref}`,
      ],
      deadline,
    );
    if (!fetch.ok) return fetch;

    const common = await fetchUntilMergeBase(
      deps,
      dir,
      baseRemote,
      pullRequest.base.ref,
      pullRequest.head.ref,
      deadline,
    );
    if (!common.ok) return common;

    const head = await runGit(deps, dir, ['show-ref', '--head', '-s', '/HEAD'], deadline);
    if (!head.ok) return head;

    if (head.value.stdout !== pullRequest.head.sha)
      return err({
        kind: 'head_changed',
        expected: pullRequest.head.sha,
        actual: head.value.stdout,
      });

    const trackedHead = await runGit(
      deps,
      dir,
      ['show-ref', '-s', `refs/remotes/origin/${pullRequest.head.ref}`],
      deadline,
    );
    if (!trackedHead.ok) return trackedHead;

    if (trackedHead.value.stdout !== pullRequest.head.sha)
      return err({
        kind: 'head_changed',
        expected: pullRequest.head.sha,
        actual: trackedHead.value.stdout,
      });

    const onto = await runGit(
      deps,
      dir,
      ['show-ref', '-s', `refs/remotes/${baseRemote}/${pullRequest.base.ref}`],
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
      [
        'push',
        '--quiet',
        `--force-with-lease=refs/heads/${pullRequest.head.ref}:${pullRequest.head.sha}`,
        'origin',
        pullRequest.head.ref,
      ],
      deadline,
    );
    if (!push.ok) return push;

    deps.logger.info(
      `Updated ${pullRequest.head.ref}: ${head.value.stdout} -> ${newHead.value.stdout}`,
    );
    return ok(newHead.value.stdout);
  });
}
