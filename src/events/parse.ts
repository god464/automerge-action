import type { RepoRef } from '@/domain/pull-request';
import { assertNever, err, ok, type Result } from '@/result';

import {
  type CheckSuiteEvent,
  type CheckSuiteWebhook,
  EVENT_NAMES,
  type EventName,
  type EventParseError,
  type ParsedEvent,
  type PullRequestEvent,
  type PullRequestRef,
  type PullRequestReviewEvent,
  type PullRequestReviewWebhook,
  type PullRequestWebhook,
  type StatusEvent,
  type StatusWebhook,
  type WorkflowRunEvent,
  type WorkflowRunWebhook,
} from './event';

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function repoFrom(value: unknown): RepoRef | null {
  const record = recordOf(value);
  if (record == null) return null;

  const ownerRecord = recordOf(record['owner']);
  const owner = ownerRecord == null ? null : stringField(ownerRecord, 'login');
  const repo = stringField(record, 'name');

  return owner != null && repo != null ? { owner, repo } : null;
}

function readPullRequests(value: unknown): readonly PullRequestRef[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    const record = recordOf(entry);
    const number = record == null ? null : numberField(record, 'number');
    return number == null ? [] : [{ number }];
  });
}

function malformed(eventName: string, detail: string): Result<never, EventParseError> {
  return err({ kind: 'malformed', eventName, detail });
}

function isSupportedEventName(value: string): value is EventName {
  return (EVENT_NAMES as readonly string[]).includes(value);
}

function parsePullRequestEvent(
  payload: Readonly<Record<string, unknown>>,
): Result<PullRequestEvent, EventParseError> {
  const pullRequest = recordOf(payload['pull_request']);
  const repo = repoFrom(payload['repository']);
  const number = pullRequest == null ? null : numberField(pullRequest, 'number');

  if (stringField(payload, 'action') == null || repo == null || number == null)
    return malformed('pull_request', 'missing action, repository, or pull_request.number');

  const event = payload as unknown as PullRequestWebhook;
  return ok({
    kind: 'pull_request',
    action: event.action,
    repo,
    pullRequestNumber: event.pull_request.number,
  });
}

function parsePullRequestReviewEvent(
  payload: Readonly<Record<string, unknown>>,
): Result<PullRequestReviewEvent, EventParseError> {
  const review = recordOf(payload['review']);
  const pullRequest = recordOf(payload['pull_request']);
  const repo = repoFrom(payload['repository']);
  const reviewState = review == null ? null : stringField(review, 'state');
  const number = pullRequest == null ? null : numberField(pullRequest, 'number');

  if (
    stringField(payload, 'action') == null ||
    repo == null ||
    reviewState == null ||
    number == null
  )
    return malformed(
      'pull_request_review',
      'missing action, review.state, repository, or pull_request.number',
    );

  const event = payload as unknown as PullRequestReviewWebhook;
  return ok({
    kind: 'pull_request_review',
    action: event.action,
    reviewState: event.review.state,
    repo,
    pullRequestNumber: event.pull_request.number,
  });
}

function parseWorkflowRunEvent(
  payload: Readonly<Record<string, unknown>>,
): Result<WorkflowRunEvent, EventParseError> {
  const workflowRun = recordOf(payload['workflow_run']);
  const repo = repoFrom(payload['repository']);

  if (stringField(payload, 'action') == null || workflowRun == null || repo == null)
    return malformed('workflow_run', 'missing action, workflow_run, or repository');

  const event = payload as unknown as WorkflowRunWebhook;
  return ok({
    kind: 'workflow_run',
    action: event.action,
    conclusion: event.workflow_run.conclusion,
    triggerEvent: stringField(workflowRun, 'event'),
    headBranch: stringField(workflowRun, 'head_branch'),
    headSha: stringField(workflowRun, 'head_sha'),
    repo,
    pullRequests: readPullRequests(workflowRun['pull_requests']),
  });
}

function parseCheckSuiteEvent(
  payload: Readonly<Record<string, unknown>>,
): Result<CheckSuiteEvent, EventParseError> {
  const checkSuite = recordOf(payload['check_suite']);
  const repo = repoFrom(payload['repository']);

  if (stringField(payload, 'action') == null || checkSuite == null || repo == null)
    return malformed('check_suite', 'missing action, check_suite, or repository');

  const event = payload as unknown as CheckSuiteWebhook;
  return ok({
    kind: 'check_suite',
    action: event.action,
    conclusion: event.check_suite.conclusion,
    headSha: stringField(checkSuite, 'head_sha'),
    repo,
    pullRequests: readPullRequests(checkSuite['pull_requests']),
  });
}

function parseStatusEvent(
  payload: Readonly<Record<string, unknown>>,
): Result<StatusEvent, EventParseError> {
  const sha = stringField(payload, 'sha');
  const repo = repoFrom(payload['repository']);

  if (stringField(payload, 'state') == null || sha == null || repo == null)
    return malformed('status', 'missing state, sha, or repository');

  const event = payload as unknown as StatusWebhook;
  return ok({ kind: 'status', state: event.state, sha: event.sha, repo });
}

export function parseEvent(
  eventName: string,
  payload: unknown,
): Result<ParsedEvent, EventParseError> {
  if (!isSupportedEventName(eventName)) return ok({ kind: 'unsupported', eventName });

  const record = recordOf(payload);
  if (record == null) return malformed(eventName, 'event payload is not an object');

  switch (eventName) {
    case 'pull_request':
      return parsePullRequestEvent(record);
    case 'pull_request_review':
      return parsePullRequestReviewEvent(record);
    case 'workflow_run':
      return parseWorkflowRunEvent(record);
    case 'check_suite':
      return parseCheckSuiteEvent(record);
    case 'status':
      return parseStatusEvent(record);
    default:
      return assertNever(eventName);
  }
}
