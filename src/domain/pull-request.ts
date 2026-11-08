export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface BranchRef {
  readonly ref: string;
  readonly sha: string;
  readonly repoFullName: string | null;
}

export type PullRequestState = 'open' | 'closed';

export type MergeableState =
  | 'clean'
  | 'has_hooks'
  | 'unstable'
  | 'blocked'
  | 'behind'
  | 'dirty'
  | 'draft'
  | 'unknown'
  | 'other';

export interface PullRequestSnapshot {
  readonly repo: RepoRef;
  readonly number: number;
  readonly title: string;
  readonly state: PullRequestState;
  readonly merged: boolean;
  readonly draft: boolean;
  readonly mergeable: boolean | null;
  readonly mergeableState: MergeableState | null;
  readonly labels: readonly string[];
  readonly head: BranchRef;
  readonly base: BranchRef;
}
