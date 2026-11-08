import type { Logger } from '../src/actions/logger.js';
import type { PullRequestSnapshot, RepoRef } from '../src/domain/pull-request.js';
import type { GitRunner } from '../src/git/command.js';
import type {
  CompareResult,
  GitHubClient,
  GitHubError,
  MergeBaseParams,
  MergeBaseResult,
  MergePullRequestParams,
  PullRequestFilter,
  PullRequestSummary,
} from '../src/github/client.js';
import { ok, type Result } from '../src/result.js';
import { pullRequest } from './factories.js';

export interface FakeClientCalls {
  readonly getPullRequest: { readonly repo: RepoRef; readonly number: number }[];
  readonly listOpenPullRequests: { readonly repo: RepoRef; readonly filter: PullRequestFilter }[];
  readonly listPullRequestsForCommit: { readonly repo: RepoRef; readonly sha: string }[];
  readonly compareCommits: {
    readonly repo: RepoRef;
    readonly base: string;
    readonly head: string;
  }[];
  readonly mergePullRequest: MergePullRequestParams[];
  readonly mergeBaseIntoHead: MergeBaseParams[];
}

export interface FakeClientOptions {
  readonly getPullRequest?: (
    repo: RepoRef,
    number: number,
  ) => Promise<Result<PullRequestSnapshot, GitHubError>>;
  readonly listOpenPullRequests?: (
    repo: RepoRef,
    filter: PullRequestFilter,
  ) => Promise<Result<readonly PullRequestSummary[], GitHubError>>;
  readonly listPullRequestsForCommit?: (
    repo: RepoRef,
    sha: string,
  ) => Promise<Result<readonly PullRequestSummary[], GitHubError>>;
  readonly compareCommits?: (
    repo: RepoRef,
    base: string,
    head: string,
  ) => Promise<Result<CompareResult, GitHubError>>;
  readonly mergePullRequest?: (
    params: MergePullRequestParams,
  ) => Promise<Result<{ readonly merged: boolean }, GitHubError>>;
  readonly mergeBaseIntoHead?: (
    params: MergeBaseParams,
  ) => Promise<Result<MergeBaseResult, GitHubError>>;
}

export interface FakeClient extends GitHubClient {
  readonly calls: FakeClientCalls;
}

export function createFakeClient(options: FakeClientOptions = {}): FakeClient {
  const calls: FakeClientCalls = {
    getPullRequest: [],
    listOpenPullRequests: [],
    listPullRequestsForCommit: [],
    compareCommits: [],
    mergePullRequest: [],
    mergeBaseIntoHead: [],
  };

  return {
    calls,
    getPullRequest: async (repo, number) => {
      calls.getPullRequest.push({ repo, number });
      return options.getPullRequest == null
        ? ok(pullRequest({ number, repo }))
        : options.getPullRequest(repo, number);
    },
    listOpenPullRequests: async (repo, filter) => {
      calls.listOpenPullRequests.push({ repo, filter });
      return options.listOpenPullRequests == null
        ? ok([])
        : options.listOpenPullRequests(repo, filter);
    },
    listPullRequestsForCommit: async (repo, sha) => {
      calls.listPullRequestsForCommit.push({ repo, sha });
      return options.listPullRequestsForCommit == null
        ? ok([])
        : options.listPullRequestsForCommit(repo, sha);
    },
    compareCommits: async (repo, base, head) => {
      calls.compareCommits.push({ repo, base, head });
      return options.compareCommits == null
        ? ok({ behindBy: 0, aheadBy: 0 })
        : options.compareCommits(repo, base, head);
    },
    mergePullRequest: async (params) => {
      calls.mergePullRequest.push(params);
      return options.mergePullRequest == null
        ? ok({ merged: true })
        : options.mergePullRequest(params);
    },
    mergeBaseIntoHead: async (params) => {
      calls.mergeBaseIntoHead.push(params);
      return options.mergeBaseIntoHead == null
        ? ok({ kind: 'up_to_date' })
        : options.mergeBaseIntoHead(params);
    },
  };
}

export interface FakeLogger extends Logger {
  readonly debugMessages: readonly string[];
  readonly infoMessages: readonly string[];
  readonly warningMessages: readonly string[];
}

export function createFakeLogger(): FakeLogger {
  const debugMessages: string[] = [];
  const infoMessages: string[] = [];
  const warningMessages: string[] = [];

  return {
    debugMessages,
    infoMessages,
    warningMessages,
    debug: (message) => debugMessages.push(message),
    info: (message) => infoMessages.push(message),
    warning: (message) => warningMessages.push(message),
  };
}

export interface FakeSleep {
  readonly calls: readonly number[];
  readonly sleep: (ms: number) => Promise<void>;
}

export function createFakeSleep(): FakeSleep {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms) => {
      calls.push(ms);
    },
  };
}

export function createUnusedGitRunner(): GitRunner {
  return {
    run: async () => {
      throw new Error('git runner should not be used in this test');
    },
  };
}
