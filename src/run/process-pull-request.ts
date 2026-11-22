import type { Logger } from '@/actions/logger';
import type { Config } from '@/config/config';
import { decideMerge } from '@/domain/merge-decision';
import {
  behindStatus,
  classifyMergeableState,
  shouldProbeBehind,
  type BehindStatus,
} from '@/domain/merge-state';
import type { MergeMethod } from '@/domain/methods';
import {
  compareHeadSpec,
  type PullRequestSnapshot,
  type RepoRef,
  sameRepo,
} from '@/domain/pull-request';
import { decideUpdate, updateEligibility } from '@/domain/update-decision';
import type { GitRunner } from '@/git/command';
import { rebaseOntoBase } from '@/git/rebase';
import type { GitHubClient, GitHubError } from '@/github/client';
import { ok, type Result } from '@/result';

import { MAX_PULL_REQUESTS_PER_LIST } from './limits';
import { resolvePullRequestSnapshot, resolveUpdateSnapshot } from './resolve-state';
import type { RunResult } from './result';

export interface ProcessDeps {
  readonly config: Config;
  readonly client: GitHubClient;
  readonly logger: Logger;
  readonly git: GitRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly cloneUrl: (repoFullName: string) => string;
}

export interface ProcessOutcome {
  readonly result: RunResult;
  readonly mergedSnapshot: PullRequestSnapshot | null;
}

function skippedOutcome(): ProcessOutcome {
  return { result: { result: 'skipped', pullRequestNumber: undefined }, mergedSnapshot: null };
}

async function updateForkBranch(
  deps: ProcessDeps,
  pullRequest: PullRequestSnapshot,
): Promise<void> {
  const result = await deps.client.updatePullRequestBranch({
    repo: pullRequest.repo,
    number: pullRequest.number,
    expectedHeadSha: pullRequest.head.sha,
  });
  if (!result.ok) {
    deps.logger.warning(
      `Failed to request branch update for PR #${pullRequest.number}: ${result.error.kind}`,
    );
    return;
  }
  deps.logger.info(`Requested branch update for PR #${pullRequest.number}`);
}

async function applyUpdate(deps: ProcessDeps, pullRequest: PullRequestSnapshot): Promise<void> {
  if (deps.config.updateMethod === 'merge') {
    const headRepo = pullRequest.head.repo;
    if (headRepo != null && !sameRepo(headRepo, pullRequest.repo)) {
      await updateForkBranch(deps, pullRequest);
      return;
    }

    const result = await deps.client.mergeBaseIntoHead({
      repo: pullRequest.repo,
      headRef: pullRequest.head.ref,
      baseRef: pullRequest.base.ref,
    });
    if (!result.ok) {
      deps.logger.warning(
        `Failed to update PR #${pullRequest.number} via merge: ${result.error.kind}`,
      );
      return;
    }
    if (result.value.kind === 'up_to_date') {
      deps.logger.info(`PR #${pullRequest.number} is already up to date`);
      return;
    }
    deps.logger.info(`Updated PR #${pullRequest.number} to ${result.value.sha}`);
    return;
  }

  const result = await rebaseOntoBase(
    { git: deps.git, logger: deps.logger, now: deps.now, cloneUrl: deps.cloneUrl },
    pullRequest,
  );
  if (!result.ok) {
    deps.logger.warning(`Failed to rebase PR #${pullRequest.number}: ${result.error.kind}`);
    return;
  }
  if (result.value == null) {
    deps.logger.info(`PR #${pullRequest.number} is already up to date`);
    return;
  }

  deps.logger.info(`Rebased PR #${pullRequest.number} to ${result.value}`);
}

async function resolveBehind(
  deps: ProcessDeps,
  pullRequest: PullRequestSnapshot,
): Promise<BehindStatus> {
  if (pullRequest.mergeableState === 'behind') {
    return 'behind';
  }
  if (!shouldProbeBehind(pullRequest)) {
    return 'up_to_date';
  }

  const compare = await deps.client.compareCommits(
    pullRequest.repo,
    pullRequest.base.ref,
    compareHeadSpec(pullRequest.repo, pullRequest.head),
  );
  if (!compare.ok) {
    deps.logger.warning(
      `Failed to compare PR #${pullRequest.number} with its base: ${compare.error.kind}`,
    );
    return 'unknown';
  }

  return behindStatus(compare.value.behindBy, pullRequest.mergeableState);
}

type UpdateOutcome = 'skipped' | 'attempted' | 'unknown';

async function maybeUpdate(
  deps: ProcessDeps,
  pullRequest: PullRequestSnapshot,
): Promise<UpdateOutcome> {
  const ineligibleReason = updateEligibility(pullRequest, deps.config.updateLabels);
  if (ineligibleReason != null) {
    deps.logger.info(`Skipping update for PR #${pullRequest.number}: ${ineligibleReason}`);
    return 'skipped';
  }

  const behind = await resolveBehind(deps, pullRequest);
  if (behind === 'unknown') {
    deps.logger.warning(
      `Cannot determine whether PR #${pullRequest.number} is behind its base; skipping update`,
    );
    return 'unknown';
  }

  const decision = decideUpdate({
    pullRequest,
    filter: deps.config.updateLabels,
    behind: behind === 'behind',
    method: deps.config.updateMethod,
  });
  if (decision.kind === 'skip') {
    deps.logger.info(`Skipping update for PR #${pullRequest.number}: ${decision.reason}`);
    return 'skipped';
  }

  deps.logger.info(
    `Updating PR #${pullRequest.number} (${pullRequest.head.ref} -> ${pullRequest.base.ref}) via ${decision.method}`,
  );
  await applyUpdate(deps, pullRequest);
  return 'attempted';
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

  if (merged.ok) {
    deps.logger.warning(`GitHub did not merge PR #${pullRequest.number}`);
  } else {
    deps.logger.warning(
      `Failed to merge PR #${pullRequest.number}: ${merged.error.kind} ${merged.error.message}`,
    );
    const refreshed = await deps.client.getPullRequest(pullRequest.repo, pullRequest.number);
    if (refreshed.ok && refreshed.value.merged) {
      deps.logger.info(`PR #${pullRequest.number} was already merged`);
      return { result: 'merged', pullRequestNumber: pullRequest.number };
    }
  }

  return { result: 'merge_failed', pullRequestNumber: pullRequest.number };
}

async function updateThenMerge(
  deps: ProcessDeps,
  pullRequest: PullRequestSnapshot,
): Promise<ProcessOutcome> {
  const outcome = await maybeUpdate(deps, pullRequest);
  if (outcome === 'unknown') {
    deps.logger.warning(
      `Refusing to merge PR #${pullRequest.number} because its state relative to the base is unknown`,
    );
    return {
      result: { result: 'not_ready', pullRequestNumber: pullRequest.number },
      mergedSnapshot: null,
    };
  }

  const current =
    outcome === 'attempted'
      ? await resolvePullRequestSnapshot(deps, pullRequest.repo, pullRequest.number)
      : ok(pullRequest);
  if (!current.ok) {
    deps.logger.warning(
      `Failed to refresh PR #${pullRequest.number} after update: ${current.error.kind}`,
    );
    return {
      result: { result: 'not_ready', pullRequestNumber: pullRequest.number },
      mergedSnapshot: null,
    };
  }

  const decision = decideMerge({
    pullRequest: current.value,
    filter: deps.config.mergeLabels,
    method: deps.config.mergeMethod,
    commitMessage: deps.config.mergeCommitMessage,
  });

  if (decision.kind === 'ready') {
    const result = await applyMerge(deps, current.value, decision.method, decision.commitTitle);
    return { result, mergedSnapshot: result.result === 'merged' ? current.value : null };
  }
  if (decision.kind === 'skip') {
    deps.logger.info(`Skipping merge for PR #${pullRequest.number}: ${decision.reason}`);
    return {
      result: { result: 'skipped', pullRequestNumber: pullRequest.number },
      mergedSnapshot: null,
    };
  }

  if (decision.reason === 'other') {
    deps.logger.warning(
      `PR #${pullRequest.number} has an unrecognized mergeable_state; treating it as not ready`,
    );
  } else {
    deps.logger.info(`PR #${pullRequest.number} is not ready: ${decision.reason}`);
  }
  return {
    result: { result: 'not_ready', pullRequestNumber: pullRequest.number },
    mergedSnapshot: null,
  };
}

export async function updatePullRequestsByBase(
  deps: ProcessDeps,
  repo: RepoRef,
  base: string,
  excludeNumber?: number,
): Promise<void> {
  const summaries = await deps.client.listOpenPullRequests(repo, {
    base,
    perPage: MAX_PULL_REQUESTS_PER_LIST,
  });
  if (!summaries.ok) {
    deps.logger.warning(`Failed to list pull requests based on ${base}: ${summaries.error.kind}`);
    return;
  }

  const seen = new Set<number>();
  let processed = 0;

  for (const pullRequest of summaries.value) {
    if (pullRequest.number === excludeNumber || seen.has(pullRequest.number)) continue;
    if (processed === MAX_PULL_REQUESTS_PER_LIST) break;

    seen.add(pullRequest.number);
    await processUpdateOnly(deps, repo, pullRequest.number, pullRequest);
    processed += 1;
  }

  if (processed === 0) {
    deps.logger.debug(`No open pull requests based on ${base}`);
    return;
  }
  deps.logger.info(`Processed ${processed} pull request(s) based on ${base}`);
}

export async function processUpdateOnly(
  deps: ProcessDeps,
  repo: RepoRef,
  number: number,
  existingSnapshot?: PullRequestSnapshot,
): Promise<ProcessOutcome> {
  if (existingSnapshot != null) {
    const ineligible = updateEligibility(existingSnapshot, deps.config.updateLabels);
    if (ineligible != null) {
      deps.logger.info(`Skipping update for PR #${number}: ${ineligible}`);
      return skippedOutcome();
    }
  }

  let snapshot: Result<PullRequestSnapshot, GitHubError>;
  if (existingSnapshot?.mergeableState != null && existingSnapshot.mergeableState !== 'unknown') {
    snapshot = ok(existingSnapshot);
  } else {
    snapshot = await resolveUpdateSnapshot(deps, repo, number);
  }

  if (!snapshot.ok) {
    deps.logger.warning(`Failed to fetch PR #${number}: ${snapshot.error.kind}`);
    return skippedOutcome();
  }

  const updateOutcome = await maybeUpdate(deps, snapshot.value);
  if (
    updateOutcome === 'skipped' &&
    classifyMergeableState(snapshot.value).kind === 'unknown' &&
    !shouldProbeBehind(snapshot.value)
  ) {
    deps.logger.warning(
      `Mergeability still unknown for PR #${number} after 2 attempts; skipping update`,
    );
  }
  return skippedOutcome();
}

export async function processUpdateAndMerge(
  deps: ProcessDeps,
  repo: RepoRef,
  number: number,
): Promise<ProcessOutcome> {
  const snapshot = await resolvePullRequestSnapshot(deps, repo, number);
  if (!snapshot.ok) {
    deps.logger.warning(`Failed to fetch PR #${number}: ${snapshot.error.kind}`);
    return { result: { result: 'skipped', pullRequestNumber: number }, mergedSnapshot: null };
  }

  return updateThenMerge(deps, snapshot.value);
}
