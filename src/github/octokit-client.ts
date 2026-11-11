import { Octokit } from '@octokit/core';

import type {
  BranchRef,
  MergeableState,
  PullRequestSnapshot,
  RepoRef,
} from '../domain/pull-request';
import { err, ok, type Result } from '../result';
import type {
  CompareResult,
  GitHubClient,
  GitHubError,
  MergeBaseResult,
  PullRequestSummary,
} from './client';

export interface GitHubClientOptions {
  readonly token: string;
  readonly baseUrl: string;
  readonly userAgent?: string;
}

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

function parseMergeableState(value: unknown): MergeableState | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    return 'other';
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

  const repo = recordOf(record['repo']);
  return { ref, sha, repoFullName: repo == null ? null : stringField(repo, 'full_name') };
}

function parseLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = recordOf(entry);
    const name = record == null ? null : stringField(record, 'name');
    return name == null ? [] : [name];
  });
}

function parsePullRequest(value: unknown): PullRequestSnapshot | null {
  const record = recordOf(value);
  if (record == null) {
    return null;
  }

  const number = numberField(record, 'number');
  const state = stringField(record, 'state');
  const baseRecord = recordOf(record['base']);
  const baseRepo = baseRecord == null ? null : parseRepo(baseRecord['repo']);
  const head = parseBranch(record['head']);
  const base = parseBranch(record['base']);

  if (number == null || state == null || baseRepo == null || head == null || base == null) {
    return null;
  }

  return {
    repo: baseRepo,
    number,
    title: stringField(record, 'title') ?? '',
    state: state === 'open' ? 'open' : 'closed',
    merged: record['merged'] === true,
    draft: record['draft'] === true,
    mergeable: typeof record['mergeable'] === 'boolean' ? record['mergeable'] : null,
    mergeableState: parseMergeableState(record['mergeable_state']),
    labels: parseLabels(record['labels']),
    head,
    base,
  };
}

function parseSummary(value: unknown): PullRequestSummary | null {
  const record = recordOf(value);
  const number = record == null ? null : numberField(record, 'number');
  return number == null ? null : { number };
}

function parseSummaryList(value: unknown): readonly PullRequestSummary[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.flatMap((entry) => {
    const summary = parseSummary(entry);
    return summary == null ? [] : [summary];
  });
}

function parseOpenSummaryList(value: unknown): readonly PullRequestSummary[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.flatMap((entry) => {
    const record = recordOf(entry);
    if (record == null || stringField(record, 'state') !== 'open') {
      return [];
    }
    const summary = parseSummary(entry);
    return summary == null ? [] : [summary];
  });
}

function parseCompare(value: unknown): CompareResult | null {
  const record = recordOf(value);
  if (record == null) {
    return null;
  }

  const behindBy = numberField(record, 'behind_by');
  const aheadBy = numberField(record, 'ahead_by');
  return behindBy == null || aheadBy == null ? null : { behindBy, aheadBy };
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
  if (status === 403 && message.toLowerCase().includes('rate limit')) {
    return { kind: 'rate_limited', message };
  }
  if (status === 403) {
    return { kind: 'forbidden', message };
  }
  if (status === 405 || status === 409 || status === 422) {
    return { kind: 'conflict', message };
  }
  if (status === 429) {
    return { kind: 'rate_limited', message };
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

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const octokit = new Octokit({
    auth: options.token,
    baseUrl: options.baseUrl,
    userAgent: options.userAgent ?? 'god464/automerge-action',
  });

  return {
    getPullRequest: (repo, number) =>
      runRequest(
        async () =>
          (
            await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
              owner: repo.owner,
              repo: repo.repo,
              pull_number: number,
              headers: { 'If-None-Match': '' },
            })
          ).data,
        parsePullRequest,
      ),

    listOpenPullRequests: (repo, filter) =>
      runRequest(
        async () =>
          (
            await octokit.request('GET /repos/{owner}/{repo}/pulls', {
              owner: repo.owner,
              repo: repo.repo,
              state: 'open',
              sort: 'updated',
              direction: 'desc',
              per_page: filter.perPage,
              ...(filter.head == null ? {} : { head: filter.head }),
              ...(filter.base == null ? {} : { base: filter.base }),
            })
          ).data,
        parseSummaryList,
      ),

    listPullRequestsForCommit: (repo, sha) =>
      runRequest(
        async () =>
          (
            await octokit.request('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', {
              owner: repo.owner,
              repo: repo.repo,
              commit_sha: sha,
            })
          ).data,
        parseOpenSummaryList,
      ),

    compareCommits: (repo, base, head) =>
      runRequest(
        async () =>
          (
            await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
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
            await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
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
        const response = await octokit.request('POST /repos/{owner}/{repo}/merges', {
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
  };
}
