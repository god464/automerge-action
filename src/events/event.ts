import type {RepoRef} from '../domain/pull-request';

export const EVENT_NAMES = [
  'pull_request',
  'pull_request_review',
  'workflow_run',
  'check_suite',
  'status',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export interface PullRequestRef {
  readonly number: number;
}

export interface PullRequestEvent {
  readonly kind: 'pull_request';
  readonly action: string;
  readonly repo: RepoRef;
  readonly pullRequestNumber: number;
}

export interface PullRequestReviewEvent {
  readonly kind: 'pull_request_review';
  readonly action: string;
  readonly reviewState: string;
  readonly repo: RepoRef;
  readonly pullRequestNumber: number;
}

export interface WorkflowRunEvent {
  readonly kind: 'workflow_run';
  readonly action: string;
  readonly conclusion: string | null;
  readonly triggerEvent: string | null;
  readonly headBranch: string | null;
  readonly headSha: string | null;
  readonly repo: RepoRef;
  readonly pullRequests: readonly PullRequestRef[];
}

export interface CheckSuiteEvent {
  readonly kind: 'check_suite';
  readonly action: string;
  readonly conclusion: string | null;
  readonly headSha: string | null;
  readonly repo: RepoRef;
  readonly pullRequests: readonly PullRequestRef[];
}

export interface StatusEvent {
  readonly kind: 'status';
  readonly state: string;
  readonly sha: string;
  readonly repo: RepoRef;
}

export interface UnsupportedEvent {
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
