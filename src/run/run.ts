import type { PullRequestSnapshot } from '@/domain/pull-request';

import type { ParsedEvent } from '../events/event';
import type { EventTargets } from '../events/targets';
import { resolveTargets } from '../events/targets';
import { assertNever } from '../result';
import { MAX_PULL_REQUESTS_PER_RUN } from './limits';
import { type ProcessDeps, processPullRequest } from './process-pull-request';
import { type RunReport, type RunResult, skippedReport } from './result';

function reportOf(results: readonly RunResult[]): RunReport {
  return {
    primary: results[0] ?? { result: 'skipped', pullRequestNumber: undefined },
    all: results,
  };
}

function uniqueNumbers(numbers: readonly number[]): readonly number[] {
  return [...new Set(numbers)].slice(0, MAX_PULL_REQUESTS_PER_RUN);
}

function uniquePullRequests(
  pullRequests: readonly PullRequestSnapshot[],
): readonly PullRequestSnapshot[] {
  const seen = new Set<number>();
  const unique: PullRequestSnapshot[] = [];

  for (const pullRequest of pullRequests) {
    if (seen.has(pullRequest.number)) continue;
    seen.add(pullRequest.number);
    unique.push(pullRequest);
    if (unique.length === MAX_PULL_REQUESTS_PER_RUN) break;
  }

  return unique;
}

async function executePullRequests(
  deps: ProcessDeps,
  target: Extract<EventTargets, { readonly kind: 'pull_requests' }>,
): Promise<RunReport> {
  const numbers = uniqueNumbers(target.numbers);
  const results: RunResult[] = [];
  for (const number of numbers) {
    results.push(await processPullRequest(deps, target.repo, number, target.mode));
  }

  return reportOf(results);
}

async function executeByCommit(
  deps: ProcessDeps,
  target: Extract<EventTargets, { readonly kind: 'pull_requests_by_commit' }>,
): Promise<RunReport> {
  const summaries = await deps.client.listPullRequestsForCommit(target.repo, target.sha);
  if (!summaries.ok) {
    deps.logger.warning(
      `Failed to find pull requests for commit ${target.sha}: ${summaries.error.kind}`,
    );
    return skippedReport();
  }

  const numbers = uniqueNumbers(summaries.value);
  if (numbers.length === 0) {
    deps.logger.info(`No open pull requests associated with commit ${target.sha}`);
    return skippedReport();
  }

  const results: RunResult[] = [];
  for (const number of numbers) {
    results.push(await processPullRequest(deps, target.repo, number, target.mode));
  }

  return reportOf(results);
}

async function executeByBase(
  deps: ProcessDeps,
  target: Extract<EventTargets, { readonly kind: 'pull_requests_by_base' }>,
): Promise<RunReport> {
  const summaries = await deps.client.listOpenPullRequests(target.repo, {
    base: target.base,
    perPage: MAX_PULL_REQUESTS_PER_RUN,
  });
  if (!summaries.ok) {
    deps.logger.warning(
      `Failed to list pull requests based on ${target.base}: ${summaries.error.kind}`,
    );
    return skippedReport();
  }

  const pullRequests = uniquePullRequests(summaries.value);
  if (pullRequests.length === 0) {
    deps.logger.info(`No open pull requests based on ${target.base}`);
    return skippedReport();
  }

  for (const pullRequest of pullRequests) {
    await processPullRequest(deps, target.repo, pullRequest.number, target.mode, pullRequest);
  }
  deps.logger.info(`Processed ${pullRequests.length} pull request(s) based on ${target.base}`);
  return skippedReport();
}

async function executeTarget(deps: ProcessDeps, target: EventTargets): Promise<RunReport> {
  switch (target.kind) {
    case 'pull_request':
      return reportOf([await processPullRequest(deps, target.repo, target.number, target.mode)]);
    case 'pull_requests':
      return executePullRequests(deps, target);
    case 'pull_requests_by_commit':
      return executeByCommit(deps, target);
    case 'pull_requests_by_base':
      return executeByBase(deps, target);
    case 'not_ready':
      deps.logger.info(
        target.reason === 'check_incomplete'
          ? 'Check is not complete yet'
          : 'Check completed unsuccessfully',
      );
      return reportOf([{ result: 'not_ready', pullRequestNumber: undefined }]);
    case 'ignored':
      deps.logger.info(`Event ignored: ${target.reason}`);
      return skippedReport();
    case 'unsupported':
      deps.logger.warning(`Unsupported event: ${target.eventName}`);
      return skippedReport();
    default:
      return assertNever(target);
  }
}

export async function runFromEvent(deps: ProcessDeps, event: ParsedEvent): Promise<RunReport> {
  return executeTarget(deps, resolveTargets(event));
}
