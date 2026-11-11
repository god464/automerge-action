import type { RepoRef } from '../domain/pull-request';
import { assertNever } from '../result';
import type {
  CheckSuiteEvent,
  ParsedEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
  StatusEvent,
  WorkflowRunEvent,
} from './event';

export const RELEVANT_PULL_REQUEST_ACTIONS = [
  'labeled',
  'unlabeled',
  'synchronize',
  'opened',
  'edited',
  'ready_for_review',
  'reopened',
  'unlocked',
] as const;

export type EventTargets =
  | {
      readonly kind: 'pull_request';
      readonly repo: RepoRef;
      readonly number: number;
      readonly mode: 'update_and_merge';
    }
  | {
      readonly kind: 'pull_requests';
      readonly repo: RepoRef;
      readonly numbers: readonly number[];
      readonly mode: 'update_and_merge';
    }
  | {
      readonly kind: 'pull_requests_by_base';
      readonly repo: RepoRef;
      readonly base: string;
      readonly mode: 'update_only';
    }
  | {
      readonly kind: 'pull_requests_by_commit';
      readonly repo: RepoRef;
      readonly sha: string;
      readonly mode: 'update_and_merge';
    }
  | { readonly kind: 'not_ready'; readonly reason: 'check_incomplete' | 'check_failed' }
  | { readonly kind: 'ignored'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly eventName: string };

function resolvePullRequest(event: PullRequestEvent): EventTargets {
  return (RELEVANT_PULL_REQUEST_ACTIONS as readonly string[]).includes(event.action)
    ? {
        kind: 'pull_request',
        repo: event.repo,
        number: event.pullRequestNumber,
        mode: 'update_and_merge',
      }
    : { kind: 'ignored', reason: `pull_request action ignored: ${event.action}` };
}

function resolvePullRequestReview(event: PullRequestReviewEvent): EventTargets {
  return event.action === 'submitted' && event.reviewState === 'approved'
    ? {
        kind: 'pull_request',
        repo: event.repo,
        number: event.pullRequestNumber,
        mode: 'update_and_merge',
      }
    : {
        kind: 'ignored',
        reason: `pull_request_review ignored: ${event.action}/${event.reviewState}`,
      };
}

function resolveWorkflowRunPullRequest(event: WorkflowRunEvent): EventTargets {
  if (event.pullRequests.length > 0) {
    return {
      kind: 'pull_requests',
      repo: event.repo,
      numbers: event.pullRequests.map((pullRequest) => pullRequest.number),
      mode: 'update_and_merge',
    };
  }

  return event.headSha == null
    ? { kind: 'ignored', reason: 'workflow_run has no associated pull request' }
    : {
        kind: 'pull_requests_by_commit',
        repo: event.repo,
        sha: event.headSha,
        mode: 'update_and_merge',
      };
}

function resolveWorkflowRunPush(event: WorkflowRunEvent): EventTargets {
  return event.headBranch == null
    ? { kind: 'ignored', reason: 'workflow_run push has no branch' }
    : {
        kind: 'pull_requests_by_base',
        repo: event.repo,
        base: event.headBranch,
        mode: 'update_only',
      };
}

function resolveWorkflowRun(event: WorkflowRunEvent): EventTargets {
  if (event.action !== 'completed') {
    return { kind: 'not_ready', reason: 'check_incomplete' };
  }
  if (event.conclusion !== 'success') {
    return { kind: 'not_ready', reason: 'check_failed' };
  }
  if (event.triggerEvent === 'pull_request') {
    return resolveWorkflowRunPullRequest(event);
  }
  if (event.triggerEvent === 'push') {
    return resolveWorkflowRunPush(event);
  }

  return { kind: 'ignored', reason: `workflow_run event ignored: ${event.triggerEvent}` };
}

function resolveCheckSuite(event: CheckSuiteEvent): EventTargets {
  if (event.action !== 'completed') {
    return { kind: 'not_ready', reason: 'check_incomplete' };
  }
  if (event.conclusion !== 'success') {
    return { kind: 'not_ready', reason: 'check_failed' };
  }
  if (event.pullRequests.length > 0) {
    return {
      kind: 'pull_requests',
      repo: event.repo,
      numbers: event.pullRequests.map((pullRequest) => pullRequest.number),
      mode: 'update_and_merge',
    };
  }

  return event.headSha == null
    ? { kind: 'ignored', reason: 'check_suite has no associated pull request' }
    : {
        kind: 'pull_requests_by_commit',
        repo: event.repo,
        sha: event.headSha,
        mode: 'update_and_merge',
      };
}

function resolveStatus(event: StatusEvent): EventTargets {
  return event.state === 'success'
    ? {
        kind: 'pull_requests_by_commit',
        repo: event.repo,
        sha: event.sha,
        mode: 'update_and_merge',
      }
    : { kind: 'ignored', reason: `status state ignored: ${event.state}` };
}

export function resolveTargets(event: ParsedEvent): EventTargets {
  switch (event.kind) {
    case 'pull_request':
      return resolvePullRequest(event);
    case 'pull_request_review':
      return resolvePullRequestReview(event);
    case 'workflow_run':
      return resolveWorkflowRun(event);
    case 'check_suite':
      return resolveCheckSuite(event);
    case 'status':
      return resolveStatus(event);
    case 'unsupported':
      return { kind: 'unsupported', eventName: event.eventName };
    default:
      return assertNever(event);
  }
}
