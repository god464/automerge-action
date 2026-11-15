import type { Logger } from '../actions/logger';
import { classifyMergeableState } from '../domain/merge-state';
import type { PullRequestSnapshot, RepoRef } from '../domain/pull-request';
import type { GitHubClient, GitHubError } from '../github/client';
import { ok, type Result } from '../result';

export const UNKNOWN_STATE_RETRIES = 3;
export const UNKNOWN_STATE_RETRY_DELAY_MS = 2000;

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

  for (let attempt = 1; attempt < UNKNOWN_STATE_RETRIES; attempt += 1) {
    deps.logger.debug(
      `Mergeability unknown for PR #${number}; retrying (${attempt + 1}/${UNKNOWN_STATE_RETRIES})`,
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
    `Mergeability still unknown for PR #${number} after ${UNKNOWN_STATE_RETRIES} attempts`,
  );
  return ok(current);
}
