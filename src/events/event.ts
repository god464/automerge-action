import type { operations } from '@octokit/openapi-webhooks-types';

import type { RepoRef } from '@/domain/pull-request';

type OperationPayload<K extends keyof operations> =
  operations[K]['requestBody']['content']['application/json'];

export type PullRequestWebhook = OperationPayload<
  Extract<keyof operations, `pull-request/${string}`>
>;
export type PullRequestReviewWebhook = OperationPayload<
  Extract<keyof operations, `pull-request-review/${string}`>
>;
export type WorkflowRunWebhook = OperationPayload<
  Extract<keyof operations, `workflow-run/${string}`>
>;
export type CheckSuiteWebhook = OperationPayload<
  Extract<keyof operations, `check-suite/${string}`>
>;
export type StatusWebhook = OperationPayload<'status'>;

export const EVENT_NAMES = [
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'workflow_run',
  'check_suite',
  'status',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export type PullRequestAction = PullRequestWebhook['action'];

export interface PullRequestRef {
  readonly number: number;
}

export interface PullRequestEvent {
  readonly kind: 'pull_request';
  readonly action: PullRequestAction;
  readonly repo: RepoRef;
  readonly pullRequestNumber: number;
}

export interface PullRequestReviewEvent {
  readonly kind: 'pull_request_review';
  readonly action: PullRequestReviewWebhook['action'];
  readonly reviewState: PullRequestReviewWebhook['review']['state'];
  readonly repo: RepoRef;
  readonly pullRequestNumber: number;
}

export interface WorkflowRunEvent {
  readonly kind: 'workflow_run';
  readonly action: WorkflowRunWebhook['action'];
  readonly conclusion: WorkflowRunWebhook['workflow_run']['conclusion'];
  readonly triggerEvent: WorkflowRunWebhook['workflow_run']['event'] | null;
  readonly headBranch: WorkflowRunWebhook['workflow_run']['head_branch'] | null;
  readonly headSha: WorkflowRunWebhook['workflow_run']['head_sha'] | null;
  readonly repo: RepoRef;
  readonly pullRequests: readonly PullRequestRef[];
}

export interface CheckSuiteEvent {
  readonly kind: 'check_suite';
  readonly action: CheckSuiteWebhook['action'];
  readonly conclusion: CheckSuiteWebhook['check_suite']['conclusion'];
  readonly headSha: CheckSuiteWebhook['check_suite']['head_sha'] | null;
  readonly repo: RepoRef;
  readonly pullRequests: readonly PullRequestRef[];
}

export interface StatusEvent {
  readonly kind: 'status';
  readonly state: StatusWebhook['state'];
  readonly sha: string;
  readonly repo: RepoRef;
}

interface UnsupportedEvent {
  readonly kind: 'unsupported';
  readonly eventName: string;
}

export type ParsedEvent =
  | PullRequestEvent
  | PullRequestReviewEvent
  | WorkflowRunEvent
  | CheckSuiteEvent
  | StatusEvent
  | UnsupportedEvent;

export interface EventParseError {
  readonly kind: 'malformed';
  readonly eventName: string;
  readonly detail: string;
}
