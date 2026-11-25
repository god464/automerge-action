import type { Logger } from '@/actions/logger';
import { classifyMergeableState } from '@/domain/merge-state';
import type { PullRequestSnapshot, RepoRef } from '@/domain/pull-request';
import type { GitHubClient, GitHubError } from '@/github/client';
import { ok, type Result } from '@/result';

const UNKNOWN_STATE_ATTEMPTS = 3;
const UNKNOWN_STATE_RETRY_DELAY_MS = 2000;
const UPDATE_ONLY_RETRY_DELAY_MS = 1000;

export interface ResolveStateDeps {
  readonly client: GitHubClient;
  readonly logger: Logger;
  readonly sleep: (ms: number) => Promise<void>;
}

export async function resolvePullRequestSnapshot(
  deps: ResolveStateDeps,
  repo: RepoRef,
  number: number,
): Promise<Result<PullRequestSnapshot, GitHubError>> {
  const first = await deps.client.getPullRequest(repo, number);
  if (!first.ok) {
    return first;
  }

  let current = first.value;
  if (classifyMergeableState(current).kind !== 'unknown') {
    return ok(current);
  }

  for (let attempt = 1; attempt < UNKNOWN_STATE_ATTEMPTS; attempt += 1) {
    deps.logger.debug(
      `Mergeability unknown for PR #${number}; retrying (${attempt + 1}/${UNKNOWN_STATE_ATTEMPTS})`,
    );
    await deps.sleep(UNKNOWN_STATE_RETRY_DELAY_MS);

    const next = await deps.client.getPullRequest(repo, number);
    if (!next.ok) {
      return next;
    }

    current = next.value;
    if (classifyMergeableState(current).kind !== 'unknown') {
      return ok(current);
    }
  }

  deps.logger.debug(
    `Mergeability still unknown for PR #${number} after ${UNKNOWN_STATE_ATTEMPTS} attempts`,
  );
  return ok(current);
}

export async function resolveUpdateSnapshot(
  deps: ResolveStateDeps,
  repo: RepoRef,
  number: number,
): Promise<Result<PullRequestSnapshot, GitHubError>> {
  const first = await deps.client.getPullRequest(repo, number);
  if (!first.ok) {
    return first;
  }
  if (classifyMergeableState(first.value).kind !== 'unknown') {
    return first;
  }

  deps.logger.debug(`Mergeability unknown for PR #${number}; retrying once for update-only`);
  await deps.sleep(UPDATE_ONLY_RETRY_DELAY_MS);

  const next = await deps.client.getPullRequest(repo, number);
  if (!next.ok) {
    return next;
  }

  return next;
}
