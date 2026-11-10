import type { MergeMethod } from '../domain/methods';
import type { PullRequestSnapshot, RepoRef } from '../domain/pull-request';
import type { Result } from '../result';

export type GitHubError =
  | { readonly kind: 'not_found'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'rate_limited'; readonly message: string }
  | { readonly kind: 'server'; readonly status: number; readonly message: string }
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'invalid_response'; readonly message: string };

export interface PullRequestSummary {
  readonly number: number;
}

export interface PullRequestFilter {
  readonly head?: string;
  readonly base?: string;
  readonly perPage: number;
}

export interface CompareResult {
  readonly behindBy: number;
  readonly aheadBy: number;
}

export interface MergePullRequestParams {
  readonly repo: RepoRef;
  readonly number: number;
  readonly sha: string;
  readonly method: MergeMethod;
  readonly commitTitle: string | undefined;
}

export interface MergeBaseParams {
  readonly repo: RepoRef;
  readonly headRef: string;
  readonly baseRef: string;
}

export type MergeBaseResult =
  | { readonly kind: 'merged'; readonly sha: string }
  | { readonly kind: 'up_to_date' };

export interface GitHubClient {
  readonly getPullRequest: (
    repo: RepoRef,
    number: number,
  ) => Promise<Result<PullRequestSnapshot, GitHubError>>;
  readonly listOpenPullRequests: (
    repo: RepoRef,
    filter: PullRequestFilter,
  ) => Promise<Result<readonly PullRequestSummary[], GitHubError>>;
  readonly listPullRequestsForCommit: (
    repo: RepoRef,
    sha: string,
  ) => Promise<Result<readonly PullRequestSummary[], GitHubError>>;
  readonly compareCommits: (
    repo: RepoRef,
    base: string,
    head: string,
  ) => Promise<Result<CompareResult, GitHubError>>;
  readonly mergePullRequest: (
    params: MergePullRequestParams,
  ) => Promise<Result<{ readonly merged: boolean }, GitHubError>>;
  readonly mergeBaseIntoHead: (
    params: MergeBaseParams,
  ) => Promise<Result<MergeBaseResult, GitHubError>>;
}
