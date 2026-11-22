import type { GitHub } from '@actions/github/lib/utils';

import type {
  BranchRef,
  MergeableState,
  PullRequestSnapshot,
  RepoRef,
} from '@/domain/pull-request';
import { err, ok, type Result } from '@/result';

import type { CompareResult, GitHubClient, GitHubError, MergeBaseResult } from './client';

export type GitHubApi = InstanceType<typeof GitHub>;

const KNOWN_MERGEABLE_STATES = [
  'clean',
  'has_hooks',
  'unstable',
  'blocked',
  'behind',
  'dirty',
  'draft',
  'unknown',
] as const;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function parseMergeableState(value: string | null): MergeableState | null {
  if (value == null) {
    return null;
  }

  return (KNOWN_MERGEABLE_STATES as readonly string[]).includes(value)
    ? (value as MergeableState)
    : 'other';
}

function parseRepo(value: unknown): RepoRef | null {
  const record = recordOf(value);
  if (record == null) {
    return null;
  }

  const owner = recordOf(record['owner']);
  const login = owner == null ? null : stringField(owner, 'login');
  const repo = stringField(record, 'name');

  return login != null && repo != null ? { owner: login, repo } : null;
}

function parseBranch(value: unknown): BranchRef | null {
  const record = recordOf(value);
  if (record == null) {
    return null;
  }

  const ref = stringField(record, 'ref');
  const sha = stringField(record, 'sha');
  if (ref == null || sha == null) {
    return null;
  }

  return { ref, sha, repo: parseRepo(record['repo']) };
}

function parseLabels(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const labels: string[] = [];
  for (const entry of value) {
    const record = recordOf(entry);
    const name = record == null ? null : stringField(record, 'name');
    if (name == null) return null;
    labels.push(name);
  }

  return labels;
}

function parsePullRequest(value: unknown): PullRequestSnapshot | null {
  const record = recordOf(value);
  if (record == null) {
    return null;
  }

  const number = numberField(record, 'number');
  const state = stringField(record, 'state');
  const title = stringField(record, 'title');
  const baseRecord = recordOf(record['base']);
  const baseRepo = baseRecord == null ? null : parseRepo(baseRecord['repo']);
  const head = parseBranch(record['head']);
  const base = parseBranch(record['base']);
  const labels = parseLabels(record['labels']);

  if (
    number == null ||
    number <= 0 ||
    title == null ||
    (state !== 'open' && state !== 'closed') ||
    baseRepo == null ||
    head == null ||
    base == null ||
    labels == null
  ) {
    return null;
  }

  const merged = record['merged'];
  const draft = record['draft'];
  const mergeableValue = record['mergeable'];
  const mergeableStateValue = record['mergeable_state'];

  if (merged !== undefined && typeof merged !== 'boolean') return null;
  if (draft !== undefined && typeof draft !== 'boolean') return null;
  if (
    mergeableValue !== undefined &&
    mergeableValue !== null &&
    typeof mergeableValue !== 'boolean'
  )
    return null;
  if (
    mergeableStateValue !== undefined &&
    mergeableStateValue !== null &&
    typeof mergeableStateValue !== 'string'
  )
    return null;

  return {
    repo: baseRepo,
    number,
    title,
    state,
    merged: merged === true,
    draft: draft === true,
    mergeable: typeof mergeableValue === 'boolean' ? mergeableValue : null,
    mergeableState: parseMergeableState(
      typeof mergeableStateValue === 'string' ? mergeableStateValue : null,
    ),
    labels,
    head,
    base,
  };
}

function parsePullRequestList(value: unknown): readonly PullRequestSnapshot[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const snapshots: PullRequestSnapshot[] = [];
  for (const entry of value) {
    const snapshot = parsePullRequest(entry);
    if (snapshot == null) return null;
    snapshots.push(snapshot);
  }

  return snapshots;
}

function parseOpenNumberList(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const openNumbers: number[] = [];
  for (const entry of value) {
    const record = recordOf(entry);
    const number = record == null ? null : numberField(record, 'number');
    const state = record == null ? null : stringField(record, 'state');
    if (number == null || number <= 0 || (state !== 'open' && state !== 'closed')) return null;

    if (state === 'open') openNumbers.push(number);
  }

  return openNumbers;
}

function parseCompare(value: unknown): CompareResult | null {
  const record = recordOf(value);
  if (record == null) {
    return null;
  }

  const behindBy = numberField(record, 'behind_by');
  const aheadBy = numberField(record, 'ahead_by');
  if (behindBy == null || aheadBy == null || behindBy < 0 || aheadBy < 0) return null;

  return { behindBy, aheadBy };
}

function parseMergeResponse(value: unknown): { readonly merged: boolean } | null {
  const record = recordOf(value);
  const merged = record == null ? null : record['merged'];
  return typeof merged === 'boolean' ? { merged } : null;
}

function parseMergeBaseResponse(value: unknown, status: number): MergeBaseResult | null {
  if (status === 204) {
    return { kind: 'up_to_date' };
  }

  const record = recordOf(value);
  const sha = record == null ? null : stringField(record, 'sha');
  return sha == null ? null : { kind: 'merged', sha };
}

function headerValue(headers: unknown, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);

  const record = recordOf(headers);
  if (record == null) return null;

  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return null;
  }

  return null;
}

function isRateLimited(
  status: number,
  message: string,
  error: Record<string, unknown> | null,
): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;

  const response = error == null ? null : recordOf(error['response']);
  const headers = response == null ? null : response['headers'];
  const remaining = headerValue(headers, 'x-ratelimit-remaining');
  const retryAfter = headerValue(headers, 'retry-after');

  return remaining === '0' || retryAfter != null || message.toLowerCase().includes('rate limit');
}

function toGitHubError(error: unknown): GitHubError {
  const record = recordOf(error);
  const status =
    record != null && typeof record['status'] === 'number' ? (record['status'] as number) : null;
  const message =
    error instanceof Error
      ? error.message
      : record != null && typeof record['message'] === 'string'
        ? record['message']
        : String(error);

  if (status === 404) {
    return { kind: 'not_found', message };
  }
  if (status != null && isRateLimited(status, message, record)) {
    return { kind: 'rate_limited', message };
  }
  if (status === 401 || status === 403) {
    return { kind: 'forbidden', message };
  }
  if (status === 400 || status === 422) {
    return { kind: 'validation', message };
  }
  if (status === 405 || status === 409) {
    return { kind: 'conflict', message };
  }
  if (status != null && status >= 500) {
    return { kind: 'server', status, message };
  }

  return status == null ? { kind: 'network', message } : { kind: 'server', status, message };
}

async function runRequest<T>(
  request: () => Promise<unknown>,
  parse: (data: unknown) => T | null,
): Promise<Result<T, GitHubError>> {
  try {
    const data = await request();
    const parsed = parse(data);
    return parsed == null
      ? err({ kind: 'invalid_response', message: 'unexpected GitHub API response shape' })
      : ok(parsed);
  } catch (error) {
    return err(toGitHubError(error));
  }
}

export function createGitHubClient(octokit: GitHubApi): GitHubClient {
  return {
    getPullRequest: (repo, number) =>
      runRequest(
        async () =>
          (
            await octokit.rest.pulls.get({
              owner: repo.owner,
              repo: repo.repo,
              pull_number: number,
              headers: { 'if-none-match': '' },
            })
          ).data,
        parsePullRequest,
      ),

    listOpenPullRequests: (repo, filter) =>
      runRequest(
        async () =>
          (
            await octokit.rest.pulls.list({
              owner: repo.owner,
              repo: repo.repo,
              state: 'open',
              sort: 'updated',
              direction: 'desc',
              per_page: filter.perPage,
              base: filter.base,
            })
          ).data,
        parsePullRequestList,
      ),

    listPullRequestsForCommit: (repo, sha) =>
      runRequest(
        async () =>
          (
            await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
              owner: repo.owner,
              repo: repo.repo,
              commit_sha: sha,
            })
          ).data,
        parseOpenNumberList,
      ),

    compareCommits: (repo, base, head) =>
      runRequest(
        async () =>
          (
            await octokit.rest.repos.compareCommitsWithBasehead({
              owner: repo.owner,
              repo: repo.repo,
              basehead: `${base}...${head}`,
            })
          ).data,
        parseCompare,
      ),

    mergePullRequest: (params) =>
      runRequest(
        async () =>
          (
            await octokit.rest.pulls.merge({
              owner: params.repo.owner,
              repo: params.repo.repo,
              pull_number: params.number,
              sha: params.sha,
              merge_method: params.method,
              ...(params.commitTitle == null ? {} : { commit_title: params.commitTitle }),
              commit_message: '',
            })
          ).data,
        parseMergeResponse,
      ),

    mergeBaseIntoHead: async (params) => {
      try {
        const response = await octokit.rest.repos.merge({
          owner: params.repo.owner,
          repo: params.repo.repo,
          base: params.headRef,
          head: params.baseRef,
        });
        const parsed = parseMergeBaseResponse(response.data, response.status);
        return parsed == null
          ? err({ kind: 'invalid_response', message: 'unexpected merge response shape' })
          : ok(parsed);
      } catch (error) {
        return err(toGitHubError(error));
      }
    },

    updatePullRequestBranch: async (params) => {
      try {
        await octokit.rest.pulls.updateBranch({
          owner: params.repo.owner,
          repo: params.repo.repo,
          pull_number: params.number,
          expected_head_sha: params.expectedHeadSha,
        });
        return ok(undefined);
      } catch (error) {
        return err(toGitHubError(error));
      }
    },
  };
}
