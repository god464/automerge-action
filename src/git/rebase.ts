import type { Logger } from '@/actions/logger';
import type { PullRequestSnapshot } from '@/domain/pull-request';
import { err, ok, type Result } from '@/result';

import type { GitError, GitRunner } from './command';
import { type TempDirError, withTempDir } from './tmpdir';

export const FETCH_DEPTH = '10';
export const FETCH_TIMEOUT_MS = 60_000;

export type RebaseError =
  | GitError
  | TempDirError
  | { readonly kind: 'head_repo_missing' }
  | { readonly kind: 'head_changed'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'timeout' };

export interface RebaseDeps {
  readonly git: GitRunner;
  readonly logger: Logger;
  readonly now: () => number;
  readonly cloneUrl: (repoFullName: string) => string;
}

async function mergeBasePair(
  deps: RebaseDeps,
  dir: string,
  left: string,
  right: string,
): Promise<Result<string | null, GitError>> {
  const result = await deps.git.run(dir, ['merge-base', left, right], { allowedExitCodes: [0, 1] });
  if (!result.ok) return result;

  return ok(result.value.exitCode === 1 ? null : result.value.stdout || null);
}

async function mergeBase(
  deps: RebaseDeps,
  dir: string,
  refs: readonly string[],
): Promise<Result<string | null, GitError>> {
  const first = refs[0];
  if (first == null)
    return err({
      kind: 'unexpected_exit',
      command: 'git merge-base',
      exitCode: 1,
      stderr: 'empty refs',
    });

  if (refs.length === 1) return ok(first);

  return refs.slice(1).reduce<Promise<Result<string | null, GitError>>>(
    async (accumulatorPromise, ref) => {
      const accumulator = await accumulatorPromise;
      if (!accumulator.ok || accumulator.value == null) return accumulator;

      return mergeBasePair(deps, dir, accumulator.value, ref);
    },
    Promise.resolve(ok(first)),
  );
}

async function mergeCommits(
  deps: RebaseDeps,
  dir: string,
  ref: string,
): Promise<Result<readonly (readonly string[])[], GitError>> {
  const result = await deps.git.run(dir, ['rev-list', '--parents', `${ref}..HEAD`]);
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
): Promise<Result<string | null, GitError>> {
  const base = await mergeBase(deps, dir, ['HEAD', ref]);
  if (!base.ok) return base;

  if (base.value == null) return ok(null);

  const commits = await mergeCommits(deps, dir, ref);
  if (!commits.ok) return commits;

  const parentResults = await Promise.all(
    commits.value.flat().map((parent) => mergeBase(deps, dir, [parent, ref])),
  );
  const errors = parentResults.flatMap((result) => (result.ok ? [] : [result.error]));
  const firstError = errors[0];
  if (firstError != null) return err(firstError);

  if (parentResults.some((result) => result.ok && result.value == null)) return ok(null);

  const bases = parentResults.flatMap((result) =>
    result.ok && result.value != null ? [result.value] : [],
  );
  const uniqueBases = [base.value, ...bases].filter(
    (value, index, all) => all.indexOf(value) === index,
  );

  return mergeBase(deps, dir, uniqueBases);
}

export async function fetchUntilMergeBase(
  deps: RebaseDeps,
  dir: string,
  branch: string,
  timeoutMs: number,
): Promise<Result<string, RebaseError>> {
  const deadline = deps.now() + timeoutMs;
  const ref = `refs/remotes/origin/${branch}`;

  async function attempt(): Promise<Result<string, RebaseError>> {
    if (deps.now() >= deadline) {
      return err({ kind: 'timeout' });
    }

    const common = await findEarliestBase(deps, dir, ref);
    if (!common.ok) return common;

    if (common.value != null) return ok(common.value);

    const deepen = await deps.git.run(dir, [
      'fetch',
      '--quiet',
      '--deepen',
      FETCH_DEPTH,
      'origin',
      `${branch}:${ref}`,
    ]);
    if (!deepen.ok) return deepen;

    return attempt();
  }

  return attempt();
}

export async function rebaseOntoBase(
  deps: RebaseDeps,
  pullRequest: PullRequestSnapshot,
): Promise<Result<string | null, RebaseError>> {
  const repoFullName = pullRequest.head.repoFullName;
  if (repoFullName == null) return err({ kind: 'head_repo_missing' });

  return withTempDir(async (dir) => {
    const clone = await deps.git.run(
      '.',
      [
        'clone',
        '--quiet',
        '--shallow-submodules',
        '--branch',
        pullRequest.head.ref,
        '--depth',
        FETCH_DEPTH,
        deps.cloneUrl(repoFullName),
        dir,
      ],
      { redactedCommand: 'git clone' },
    );
    if (!clone.ok) return clone;

    const fetch = await deps.git.run(dir, [
      'fetch',
      '--quiet',
      '--depth',
      FETCH_DEPTH,
      'origin',
      `${pullRequest.base.ref}:refs/remotes/origin/${pullRequest.base.ref}`,
    ]);
    if (!fetch.ok) return fetch;

    const base = await fetchUntilMergeBase(deps, dir, pullRequest.base.ref, FETCH_TIMEOUT_MS);
    if (!base.ok) return base;

    const head = await deps.git.run(dir, ['show-ref', '--head', '-s', '/HEAD']);
    if (!head.ok) return head;

    if (head.value.stdout !== pullRequest.head.sha)
      return err({
        kind: 'head_changed',
        expected: pullRequest.head.sha,
        actual: head.value.stdout,
      });

    const onto = await deps.git.run(dir, [
      'show-ref',
      '-s',
      `refs/remotes/origin/${pullRequest.base.ref}`,
    ]);
    if (!onto.ok) return onto;

    deps.logger.info(`Rebasing ${pullRequest.head.ref} onto ${pullRequest.base.ref}`);
    const rebase = await deps.git.run(dir, [
      'rebase',
      '--quiet',
      '--autosquash',
      onto.value.stdout,
    ]);
    if (!rebase.ok) return rebase;

    const newHead = await deps.git.run(dir, ['show-ref', '--head', '-s', '/HEAD']);
    if (!newHead.ok) return newHead;

    if (newHead.value.stdout === head.value.stdout) {
      deps.logger.info(`Already up to date: ${pullRequest.head.ref}`);
      return ok(null);
    }

    const push = await deps.git.run(dir, [
      'push',
      '--quiet',
      '--force-with-lease',
      'origin',
      pullRequest.head.ref,
    ]);
    if (!push.ok) return push;

    deps.logger.info(
      `Updated ${pullRequest.head.ref}: ${head.value.stdout} -> ${newHead.value.stdout}`,
    );
    return ok(newHead.value.stdout);
  });
}
