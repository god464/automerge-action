import {type LabelFilter, labelSkipReason, type LabelSkipReason} from './labels';
import type {UpdateMethod} from './methods';
import type {PullRequestSnapshot} from './pull-request';

export type UpdateSkipReason =
  | 'not_open'
  | 'already_merged'
  | 'head_repo_missing'
  | LabelSkipReason
  | 'not_behind';

export type UpdateDecision =
  | { readonly kind: 'update'; readonly method: UpdateMethod }
  | { readonly kind: 'skip'; readonly reason: UpdateSkipReason };

export interface UpdateInput {
  readonly pullRequest: PullRequestSnapshot;
  readonly filter: LabelFilter;
  readonly behind: boolean;
  readonly method: UpdateMethod;
}

export function updateEligibility(
  pullRequest: PullRequestSnapshot,
  filter: LabelFilter,
): UpdateSkipReason | null {
  if (pullRequest.state !== 'open') {
    return 'not_open';
  }
  if (pullRequest.merged) {
    return 'already_merged';
  }
  if (pullRequest.head.repoFullName == null) {
    return 'head_repo_missing';
  }

  return labelSkipReason(pullRequest.labels, filter);
}

export function decideUpdate(input: UpdateInput): UpdateDecision {
  const reason = updateEligibility(input.pullRequest, input.filter);
  if (reason != null) {
    return { kind: 'skip', reason };
  }

  return input.behind
    ? { kind: 'update', method: input.method }
    : { kind: 'skip', reason: 'not_behind' };
}
