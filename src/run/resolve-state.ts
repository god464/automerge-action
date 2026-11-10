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

async function retryUnknownState(
  deps: ResolveStateDeps,
  repo: RepoRef,
  number: number,
  current: PullRequestSnapshot,
  attempt: number,
): Promise<Result<PullRequestSnapshot, GitHubError>> {
  if (attempt >= UNKNOWN_STATE_RETRIES) {
    deps.logger.debug(
      `Mergeability still unknown for PR #${number} after ${UNKNOWN_STATE_RETRIES} attempts`,
    );
    return ok(current);
  }

  deps.logger.debug(
    `Mergeability unknown for PR #${number}; retrying (${attempt + 1}/${UNKNOWN_STATE_RETRIES})`,
  );
  await deps.sleep(UNKNOWN_STATE_RETRY_DELAY_MS);

  const next = await deps.client.getPullRequest(repo, number);
  if (!next.ok) {
    return next;
  }
  if (classifyMergeableState(next.value).kind !== 'unknown') {
    return ok(next.value);
  }

  return retryUnknownState(deps, repo, number, next.value, attempt + 1);
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
  if (classifyMergeableState(first.value).kind !== 'unknown') {
    return first;
  }

  return retryUnknownState(deps, repo, number, first.value, 1);
}
