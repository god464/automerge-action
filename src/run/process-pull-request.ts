import type { Logger } from '../actions/logger.js';
import type { Config } from '../config/config.js';
import { decideMerge } from '../domain/merge-decision.js';
import { isBehind, shouldProbeBehind } from '../domain/merge-state.js';
import type { MergeMethod } from '../domain/methods.js';
import type { PullRequestSnapshot, RepoRef } from '../domain/pull-request.js';
import { decideUpdate, updateEligibility } from '../domain/update-decision.js';
import type { GitRunner } from '../git/command.js';
import { rebaseOntoBase } from '../git/rebase.js';
import type { GitHubClient } from '../github/client.js';
import { ok } from '../result.js';
import { MAX_PULL_REQUESTS_PER_RUN } from './limits.js';
import { mapSeries } from './map-series.js';
import { resolvePullRequestSnapshot } from './resolve-state.js';
import type { RunResult } from './result.js';

export interface ProcessDeps {
  readonly config: Config;
  readonly client: GitHubClient;
  readonly logger: Logger;
  readonly git: GitRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly cloneUrl: (repoFullName: string) => string;
}

type UpdateOutcome =
  | { readonly kind: 'updated'; readonly sha: string }
  | { readonly kind: 'up_to_date' }
  | { readonly kind: 'failed' };

async function applyUpdate(
  deps: ProcessDeps,
  pullRequest: PullRequestSnapshot,
): Promise<UpdateOutcome> {
  if (deps.config.updateMethod === 'merge') {
    const result = await deps.client.mergeBaseIntoHead({
      repo: pullRequest.repo,
      headRef: pullRequest.head.ref,
      baseRef: pullRequest.base.ref,
    });
    if (!result.ok) {
      deps.logger.warning(
        `Failed to update PR #${pullRequest.number} via merge: ${result.error.kind}`,
      );
      return { kind: 'failed' };
    }
    if (result.value.kind === 'up_to_date') {
      deps.logger.info(`PR #${pullRequest.number} is already up to date`);
      return { kind: 'up_to_date' };
    }
    deps.logger.info(`Updated PR #${pullRequest.number} to ${result.value.sha}`);
    return { kind: 'updated', sha: result.value.sha };
  }

  const result = await rebaseOntoBase(
    { git: deps.git, logger: deps.logger, now: deps.now, cloneUrl: deps.cloneUrl },
    pullRequest,
  );
  if (!result.ok) {
    deps.logger.warning(`Failed to rebase PR #${pullRequest.number}: ${result.error.kind}`);
    return { kind: 'failed' };
  }
  if (result.value == null) {
    deps.logger.info(`PR #${pullRequest.number} is already up to date`);
    return { kind: 'up_to_date' };
  }

  deps.logger.info(`Rebased PR #${pullRequest.number} to ${result.value}`);
  return { kind: 'updated', sha: result.value };
}

async function resolveBehind(
  deps: ProcessDeps,
  pullRequest: PullRequestSnapshot,
): Promise<boolean> {
  if (pullRequest.mergeableState === 'behind') {
    return true;
  }
  if (!shouldProbeBehind(pullRequest)) {
    return false;
  }

  const compare = await deps.client.compareCommits(
    pullRequest.repo,
    pullRequest.base.ref,
    pullRequest.head.ref,
  );
  if (!compare.ok) {
    deps.logger.warning(
      `Failed to compare PR #${pullRequest.number} with its base: ${compare.error.kind}`,
    );
    return false;
  }

  return isBehind(compare.value.behindBy, pullRequest.mergeableState);
}

async function maybeUpdate(deps: ProcessDeps, pullRequest: PullRequestSnapshot): Promise<boolean> {
  const ineligibleReason = updateEligibility(pullRequest, deps.config.updateLabels);
  if (ineligibleReason != null) {
    deps.logger.info(`Skipping update for PR #${pullRequest.number}: ${ineligibleReason}`);
    return false;
  }

  const behind = await resolveBehind(deps, pullRequest);
  const decision = decideUpdate({
    pullRequest,
    filter: deps.config.updateLabels,
    behind,
    method: deps.config.updateMethod,
  });
  if (decision.kind === 'skip') {
    deps.logger.info(`Skipping update for PR #${pullRequest.number}: ${decision.reason}`);
    return false;
  }

  deps.logger.info(
    `Updating PR #${pullRequest.number} (${pullRequest.head.ref} -> ${pullRequest.base.ref}) via ${decision.method}`,
  );
  await applyUpdate(deps, pullRequest);
  return true;
}

async function applyMerge(
  deps: ProcessDeps,
  pullRequest: PullRequestSnapshot,
  method: MergeMethod,
  commitTitle: string | undefined,
): Promise<RunResult> {
  const merged = await deps.client.mergePullRequest({
    repo: pullRequest.repo,
    number: pullRequest.number,
    sha: pullRequest.head.sha,
    method,
    commitTitle,
  });

  if (merged.ok && merged.value.merged) {
    deps.logger.info(`Merged PR #${pullRequest.number}`);
    return { result: 'merged', pullRequestNumber: pullRequest.number };
  }

  if (!merged.ok) {
    deps.logger.warning(
      `Failed to merge PR #${pullRequest.number}: ${merged.error.kind} ${merged.error.message}`,
    );
    const refreshed = await deps.client.getPullRequest(pullRequest.repo, pullRequest.number);
    if (refreshed.ok && refreshed.value.merged) {
      deps.logger.info(`PR #${pullRequest.number} was already merged`);
      return { result: 'merged', pullRequestNumber: pullRequest.number };
    }
  } else {
    deps.logger.warning(`GitHub did not merge PR #${pullRequest.number}`);
  }

  return { result: 'merge_failed', pullRequestNumber: pullRequest.number };
}

async function updateThenMerge(
  deps: ProcessDeps,
  pullRequest: PullRequestSnapshot,
): Promise<RunResult> {
  const attempted = await maybeUpdate(deps, pullRequest);
  const current = attempted
    ? await resolvePullRequestSnapshot(deps, pullRequest.repo, pullRequest.number)
    : ok(pullRequest);
  if (!current.ok) {
    deps.logger.warning(
      `Failed to refresh PR #${pullRequest.number} after update: ${current.error.kind}`,
    );
    return { result: 'not_ready', pullRequestNumber: pullRequest.number };
  }

  const decision = decideMerge({
    pullRequest: current.value,
    filter: deps.config.mergeLabels,
    method: deps.config.mergeMethod,
    commitMessage: deps.config.mergeCommitMessage,
  });

  if (decision.kind === 'ready') {
    return applyMerge(deps, current.value, decision.method, decision.commitTitle);
  }
  if (decision.kind === 'skip') {
    deps.logger.info(`Skipping merge for PR #${pullRequest.number}: ${decision.reason}`);
    return { result: 'skipped', pullRequestNumber: pullRequest.number };
  }

  if (decision.reason === 'other') {
    deps.logger.warning(
      `PR #${pullRequest.number} has an unrecognized mergeable_state; treating it as not ready`,
    );
  } else {
    deps.logger.info(`PR #${pullRequest.number} is not ready: ${decision.reason}`);
  }
  return { result: 'not_ready', pullRequestNumber: pullRequest.number };
}

async function updateOtherPullRequests(
  deps: ProcessDeps,
  merged: PullRequestSnapshot,
): Promise<void> {
  const summaries = await deps.client.listOpenPullRequests(merged.repo, {
    base: merged.base.ref,
    perPage: MAX_PULL_REQUESTS_PER_RUN,
  });
  if (!summaries.ok) {
    deps.logger.warning(
      `Failed to list pull requests based on ${merged.base.ref}: ${summaries.error.kind}`,
    );
    return;
  }

  const numbers = summaries.value
    .map((summary) => summary.number)
    .filter((number) => number !== merged.number)
    .filter((number, index, all) => all.indexOf(number) === index)
    .slice(0, MAX_PULL_REQUESTS_PER_RUN);
  if (numbers.length === 0) {
    deps.logger.debug(`No other open pull requests based on ${merged.base.ref}`);
    return;
  }

  const results = await mapSeries(numbers, (number) =>
    processPullRequest(deps, merged.repo, number, 'update_only'),
  );
  deps.logger.info(`Processed ${results.length} other pull request(s) based on ${merged.base.ref}`);
}

export async function processPullRequest(
  deps: ProcessDeps,
  repo: RepoRef,
  number: number,
  mode: 'update_and_merge' | 'update_only',
): Promise<RunResult> {
  const snapshot = await resolvePullRequestSnapshot(deps, repo, number);
  if (!snapshot.ok) {
    deps.logger.warning(`Failed to fetch PR #${number}: ${snapshot.error.kind}`);
    return { result: 'skipped', pullRequestNumber: number };
  }

  if (mode === 'update_only') {
    await maybeUpdate(deps, snapshot.value);
    return { result: 'skipped', pullRequestNumber: undefined };
  }

  const result = await updateThenMerge(deps, snapshot.value);
  if (result.result === 'merged') {
    await updateOtherPullRequests(deps, snapshot.value);
  }
  return result;
}
