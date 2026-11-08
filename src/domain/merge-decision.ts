import { labelSkipReason, type LabelFilter, type LabelSkipReason } from './labels.js';
import { classifyMergeableState, type NotReadyReason } from './merge-state.js';
import type { MergeCommitMessage, MergeMethod } from './methods.js';
import type { PullRequestSnapshot } from './pull-request.js';

export type MergeSkipReason = 'not_open' | 'already_merged' | 'head_repo_missing' | LabelSkipReason;

export type MergeNotReadyReason = NotReadyReason | 'unknown';

export type MergeDecision =
  | {
      readonly kind: 'ready';
      readonly method: MergeMethod;
      readonly commitTitle: string | undefined;
    }
  | { readonly kind: 'skip'; readonly reason: MergeSkipReason }
  | { readonly kind: 'not_ready'; readonly reason: MergeNotReadyReason };

export interface MergeInput {
  readonly pullRequest: PullRequestSnapshot;
  readonly filter: LabelFilter;
  readonly method: MergeMethod;
  readonly commitMessage: MergeCommitMessage;
}

export function commitTitleFor(message: MergeCommitMessage, title: string): string | undefined {
  return message === 'pull-request-title' ? title : undefined;
}

export function decideMerge(input: MergeInput): MergeDecision {
  const { pullRequest } = input;
  if (pullRequest.state !== 'open') {
    return { kind: 'skip', reason: 'not_open' };
  }
  if (pullRequest.merged) {
    return { kind: 'skip', reason: 'already_merged' };
  }
  if (pullRequest.head.repoFullName == null) {
    return { kind: 'skip', reason: 'head_repo_missing' };
  }

  const labelReason = labelSkipReason(pullRequest.labels, input.filter);
  if (labelReason != null) {
    return { kind: 'skip', reason: labelReason };
  }

  const classification = classifyMergeableState(pullRequest);
  if (classification.kind === 'ready') {
    return {
      kind: 'ready',
      method: input.method,
      commitTitle: commitTitleFor(input.commitMessage, pullRequest.title),
    };
  }
  if (classification.kind === 'not_ready') {
    return { kind: 'not_ready', reason: classification.reason };
  }

  return { kind: 'not_ready', reason: 'unknown' };
}
