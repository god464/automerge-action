import type { Octokit } from '@octokit/rest';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export type MergeResult = 'skipped' | 'not_ready' | 'author_filtered' | 'merge_failed' | 'merged';

export interface Label {
  name: string;
}

export interface RepoRef {
  name: string;
  full_name: string;
  owner: { login: string };
}

export interface BranchRef {
  ref: string;
  sha: string;
  repo: RepoRef;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged?: boolean | null;
  mergeable_state?: string | null;
  labels: Label[];
  head: BranchRef;
  base: BranchRef;
  user: { login: string };
}

export interface Repository {
  name: string;
  owner: { login: string };
}

export interface LabelFilter {
  required: string[];
  blocking: string[];
}

export interface MergeMethodLabel {
  label: string;
  method: string;
}

export interface PullRequestInput {
  repoOwner?: string;
  repoName?: string;
  pullRequestNumber: number;
}

export type ConfigEnv = Record<string, string | number | undefined>;

export interface Config {
  mergeLabels: LabelFilter;
  mergeRemoveLabels: string[];
  mergeMethod: string;
  mergeMethodLabels: MergeMethodLabel[];
  mergeMethodLabelRequired: boolean;
  mergeForks: boolean;
  mergeCommitMessage: string;
  mergeCommitMessageRegex: string;
  mergeFilterAuthor: string;
  mergeRetries: number;
  mergeRetrySleep: number;
  mergeRequiredApprovals: number;
  mergeDeleteBranch: boolean;
  mergeDeleteBranchFilter: string[];
  mergeErrorFail: boolean;
  mergeReadyState: string[];
  updateLabels: LabelFilter;
  updateMethod: string;
  updateRetries: number;
  updateRetrySleep: number;
  baseBranches: string[];
  pullRequest: PullRequestInput | null;
}

export interface MergeContext {
  octokit: Octokit;
  config: Config;
}

export interface Context extends MergeContext {
  token: string;
}

export interface ActionResult {
  mergeResult: MergeResult;
  pullRequestNumber?: number;
}

/**
 * Sink for GitHub Actions step outputs. Injected so that the library does not
 * depend on `@actions/core` (ESM-only) at module load time, which would make it
 * unloadable from CommonJS dev entry points.
 */
export interface ActionOutputs {
  setOutput(name: string, value: unknown): void;
}

export type ActionResultLike = ActionResult | ActionResult[] | void;

export interface CheckPayload {
  conclusion?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  pull_requests?: Array<{ url: string }>;
}

export interface EventData {
  action?: string;
  ref?: string;
  state?: string;
  repository?: Repository;
  pull_request?: PullRequest;
  review?: { state: string };
  issue?: PullRequest & { pull_request?: unknown };
  branches?: Array<{ name: string }>;
  check_suite?: CheckPayload;
  check_run?: CheckPayload;
  workflow_run?: CheckPayload;
  [key: string]: unknown;
}
