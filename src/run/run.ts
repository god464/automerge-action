import { assertNever } from '../result';
import type { EventTargets } from '../events/targets';
import { resolveTargets } from '../events/targets';
import type { ParsedEvent } from '../events/event';
import { MAX_PULL_REQUESTS_PER_RUN } from './limits';
import { mapSeries } from './map-series';
import { type ProcessDeps, processPullRequest } from './process-pull-request';
import { type RunReport, type RunResult, skippedReport } from './result';

export type RunDeps = ProcessDeps;

function reportOf(results: readonly RunResult[]): RunReport {
  return {
    primary: results[0] ?? { result: 'skipped', pullRequestNumber: undefined },
    all: results,
  };
}

function uniqueNumbers(numbers: readonly number[]): readonly number[] {
  return numbers
    .filter((number, index) => numbers.indexOf(number) === index)
    .slice(0, MAX_PULL_REQUESTS_PER_RUN);
}

async function executePullRequests(
  deps: RunDeps,
  target: Extract<EventTargets, { readonly kind: 'pull_requests' }>,
): Promise<RunReport> {
  const numbers = uniqueNumbers(target.numbers);
  if (numbers.length === 0) {
    deps.logger.info('No pull requests found for event');
    return skippedReport();
  }

  return reportOf(
    await mapSeries(numbers, (number) =>
      processPullRequest(deps, target.repo, number, target.mode),
    ),
  );
}

async function executeByCommit(
  deps: RunDeps,
  target: Extract<EventTargets, { readonly kind: 'pull_requests_by_commit' }>,
): Promise<RunReport> {
  const summaries = await deps.client.listPullRequestsForCommit(target.repo, target.sha);
  if (!summaries.ok) {
    deps.logger.warning(
      `Failed to find pull requests for commit ${target.sha}: ${summaries.error.kind}`,
    );
    return skippedReport();
  }

  const numbers = uniqueNumbers(summaries.value.map((summary) => summary.number));
  if (numbers.length === 0) {
    deps.logger.info(`No open pull requests associated with commit ${target.sha}`);
    return skippedReport();
  }

  return reportOf(
    await mapSeries(numbers, (number) =>
      processPullRequest(deps, target.repo, number, target.mode),
    ),
  );
}

async function executeByBase(
  deps: RunDeps,
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

  const numbers = uniqueNumbers(summaries.value.map((summary) => summary.number));
  if (numbers.length === 0) {
    deps.logger.info(`No open pull requests based on ${target.base}`);
    return skippedReport();
  }

  const results = await mapSeries(numbers, (number) =>
    processPullRequest(deps, target.repo, number, target.mode),
  );
  deps.logger.info(`Processed ${results.length} pull request(s) based on ${target.base}`);
  return skippedReport();
}

async function executeTarget(deps: RunDeps, target: EventTargets): Promise<RunReport> {
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

export async function runFromEvent(deps: RunDeps, event: ParsedEvent): Promise<RunReport> {
  return executeTarget(deps, resolveTargets(event));
}
