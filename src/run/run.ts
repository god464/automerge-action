import type { RepoRef } from '@/domain/pull-request';
import type { ParsedEvent } from '@/events/event';
import type { EventTargets } from '@/events/targets';
import { resolveTargets } from '@/events/targets';
import { assertNever } from '@/result';

import { MAX_PULL_REQUESTS_PER_LIST } from './limits';
import {
  type ProcessDeps,
  processUpdateAndMerge,
  updatePullRequestsByBase,
} from './process-pull-request';
import { type RunReport, type RunResult, skippedReport } from './result';

function reportOf(results: readonly RunResult[]): RunReport {
  return { primary: results[0] ?? { result: 'skipped', pullRequestNumber: undefined } };
}

function uniqueNumbers(numbers: readonly number[]): readonly number[] {
  return [...new Set(numbers)].slice(0, MAX_PULL_REQUESTS_PER_LIST);
}

async function processAndFanOut(
  deps: ProcessDeps,
  repo: RepoRef,
  number: number,
): Promise<RunResult> {
  const outcome = await processUpdateAndMerge(deps, repo, number);
  if (outcome.mergedSnapshot != null) {
    await updatePullRequestsByBase(
      deps,
      outcome.mergedSnapshot.repo,
      outcome.mergedSnapshot.base.ref,
      outcome.mergedSnapshot.number,
    );
  }
  return outcome.result;
}

async function executePullRequests(
  deps: ProcessDeps,
  target: Extract<EventTargets, { readonly kind: 'pull_requests' }>,
): Promise<RunReport> {
  const numbers = uniqueNumbers(target.numbers);
  const results: RunResult[] = [];
  for (const number of numbers) {
    results.push(await processAndFanOut(deps, target.repo, number));
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
    results.push(await processAndFanOut(deps, target.repo, number));
  }

  return reportOf(results);
}

async function executeByBase(
  deps: ProcessDeps,
  target: Extract<EventTargets, { readonly kind: 'pull_requests_by_base' }>,
): Promise<RunReport> {
  await updatePullRequestsByBase(deps, target.repo, target.base);
  return skippedReport();
}

async function executeTarget(deps: ProcessDeps, target: EventTargets): Promise<RunReport> {
  switch (target.kind) {
    case 'pull_request':
      return reportOf([await processAndFanOut(deps, target.repo, target.number)]);
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
