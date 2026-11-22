export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface BranchRef {
  readonly ref: string;
  readonly sha: string;
  readonly repo: RepoRef | null;
}

export function repoFullName(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

export function sameRepo(left: RepoRef, right: RepoRef): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

export function compareHeadSpec(baseRepo: RepoRef, head: BranchRef): string {
  return head.repo == null || sameRepo(head.repo, baseRepo)
    ? head.ref
    : `${head.repo.owner}:${head.ref}`;
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
