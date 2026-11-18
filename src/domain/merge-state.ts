import type { MergeableState, PullRequestSnapshot } from './pull-request';

export type NotReadyReason = 'mergeable_false' | 'draft' | 'blocked' | 'behind' | 'dirty' | 'other';

export type MergeableClassification =
  | { readonly kind: 'ready' }
  | { readonly kind: 'not_ready'; readonly reason: NotReadyReason }
  | { readonly kind: 'unknown' };

export type BehindStatus = 'behind' | 'up_to_date' | 'unknown';

type NotReadyState = Exclude<MergeableState, 'unknown' | 'clean' | 'has_hooks' | 'unstable'>;

const NOT_READY_REASONS: Readonly<Record<NotReadyState, NotReadyReason>> = {
  blocked: 'blocked',
  behind: 'behind',
  dirty: 'dirty',
  draft: 'draft',
  other: 'other',
};

function classifyKnownState(state: MergeableState | null): MergeableClassification {
  if (state == null || state === 'unknown') return { kind: 'unknown' };

  if (state === 'clean' || state === 'has_hooks' || state === 'unstable') return { kind: 'ready' };

  return { kind: 'not_ready', reason: NOT_READY_REASONS[state] };
}

export function classifyMergeableState(snapshot: PullRequestSnapshot): MergeableClassification {
  if (snapshot.mergeable === false) return { kind: 'not_ready', reason: 'mergeable_false' };

  if (snapshot.draft) return { kind: 'not_ready', reason: 'draft' };

  const classification = classifyKnownState(snapshot.mergeableState);
  if (classification.kind === 'not_ready' || snapshot.mergeable === true) return classification;

  // mergeable can be null while GitHub computes mergeability. A clean-looking
  // mergeable_state is not enough: mergeability itself is still unknown.
  return { kind: 'unknown' };
}

export function shouldProbeBehind(snapshot: PullRequestSnapshot): boolean {
  return (
    snapshot.mergeable !== false &&
    !snapshot.draft &&
    (snapshot.mergeableState === 'blocked' || snapshot.mergeableState === 'unstable')
  );
}

export function behindStatus(behindBy: number | null, state: MergeableState | null): BehindStatus {
  if (behindBy != null) return behindBy > 0 ? 'behind' : 'up_to_date';
  return state === 'behind' ? 'behind' : 'unknown';
}
