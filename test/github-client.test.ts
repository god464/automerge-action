import * as github from '@actions/github';
import { describe, expect, it } from 'vitest';

import { createGitHubClient } from '@/github/octokit-client';

import { expectOk } from './factories';

const repo = { owner: 'owner', repo: 'repo' };

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface StubResponse {
  readonly status?: number;
  readonly body?: unknown;
}

function parsedBody(body: BodyInit | null | undefined): unknown {
  if (body == null) return null;
  if (typeof body !== 'string') throw new Error('expected a string request body');
  return JSON.parse(body);
}

function requestOf(input: RequestInfo | URL, init: RequestInit = {}): RecordedRequest {
  const rawUrl = input instanceof Request ? input.url : String(input);
  return {
    url: new URL(rawUrl),
    method: init.method ?? 'GET',
    headers: Object.fromEntries(new Headers(init.headers)),
    body: parsedBody(init.body),
  };
}

function createClient(respond: (request: RecordedRequest) => StubResponse) {
  const requests: RecordedRequest[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const request = requestOf(input, init);
    requests.push(request);
    const response = respond(request);

    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const octokit = github.getOctokit('token', { request: { fetch: fetchStub } });

  return { client: createGitHubClient(octokit), requests };
}

function pullRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: 'Update README',
    state: 'open',
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    labels: [{ name: 'automerge' }, { name: 'ready' }, { name: 42 }],
    head: { ref: 'feature', sha: 'head-sha', repo: { full_name: 'owner/repo' } },
    base: {
      ref: 'main',
      sha: 'base-sha',
      repo: { name: 'repo', full_name: 'owner/repo', owner: { login: 'owner' } },
    },
    ...overrides,
  };
}

describe('getPullRequest', () => {
  it('requests one pull request and parses a domain snapshot', async () => {
    const { client, requests } = createClient(() => ({ body: pullRequestPayload() }));

    const snapshot = expectOk(await client.getPullRequest(repo, 7));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toEqual('GET');
    expect(requests[0]?.url.pathname).toEqual('/repos/owner/repo/pulls/7');
    expect(requests[0]?.headers['if-none-match']).toEqual('');
    expect(snapshot).toEqual({
      repo,
      number: 7,
      title: 'Update README',
      state: 'open',
      merged: false,
      draft: false,
      mergeable: true,
      mergeableState: 'clean',
      labels: ['automerge', 'ready'],
      head: { ref: 'feature', sha: 'head-sha', repoFullName: 'owner/repo' },
      base: { ref: 'main', sha: 'base-sha', repoFullName: 'owner/repo' },
    });
  });

  it('preserves null and unrecognized mergeability information', async () => {
    let call = 0;
    const { client } = createClient(() => {
      call += 1;
      return {
        body:
          call === 1
            ? pullRequestPayload({ mergeable: null, mergeable_state: null })
            : pullRequestPayload({ mergeable_state: 'brand-new-state' }),
      };
    });

    const missing = expectOk(await client.getPullRequest(repo, 7));
    const unknown = expectOk(await client.getPullRequest(repo, 7));

    expect(missing.mergeable).toBeNull();
    expect(missing.mergeableState).toBeNull();
    expect(unknown.mergeableState).toEqual('other');
  });

  it('rejects responses without a usable repository, head, or base', async () => {
    const { client } = createClient(() => ({
      body: pullRequestPayload({ base: { ref: 'main', sha: 'sha', repo: null } }),
    }));

    expect(await client.getPullRequest(repo, 7)).toEqual({
      ok: false,
      error: { kind: 'invalid_response', message: 'unexpected GitHub API response shape' },
    });
  });

  it.each([
    pullRequestPayload({ head: null }),
    pullRequestPayload({ head: { ref: 'feature', repo: { full_name: 'owner/repo' } } }),
  ])('rejects missing head branches', async (body) => {
    const { client } = createClient(() => ({ body }));

    expect((await client.getPullRequest(repo, 7)).ok).toBe(false);
  });

  it('tolerates malformed optional fields', async () => {
    const { client } = createClient(() => ({
      body: pullRequestPayload({ labels: 'automerge', mergeable_state: 42 }),
    }));

    const snapshot = expectOk(await client.getPullRequest(repo, 7));

    expect(snapshot.labels).toEqual([]);
    expect(snapshot.mergeableState).toEqual('other');
  });
});

describe('listOpenPullRequests', () => {
  it('requests one page with the base filter and parses snapshots', async () => {
    const { client, requests } = createClient(() => ({
      body: [pullRequestPayload(), pullRequestPayload({ number: 8, state: 'closed' }), null],
    }));

    const snapshots = expectOk(
      await client.listOpenPullRequests(repo, { base: 'main', perPage: 10 }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toEqual('/repos/owner/repo/pulls');
    expect(requests[0]?.url.searchParams.get('state')).toEqual('open');
    expect(requests[0]?.url.searchParams.get('sort')).toEqual('updated');
    expect(requests[0]?.url.searchParams.get('direction')).toEqual('desc');
    expect(requests[0]?.url.searchParams.get('per_page')).toEqual('10');
    expect(requests[0]?.url.searchParams.get('base')).toEqual('main');
    expect(snapshots.map((snapshot) => snapshot.number)).toEqual([7, 8]);
  });

  it('rejects a non-array payload', async () => {
    const { client } = createClient(() => ({ body: { message: 'nope' } }));

    expect((await client.listOpenPullRequests(repo, { base: 'main', perPage: 10 })).ok).toBe(false);
  });
});

describe('listPullRequestsForCommit', () => {
  it('returns open pull request numbers and ignores closed or invalid entries', async () => {
    const { client, requests } = createClient(() => ({
      body: [
        { number: 1, state: 'open' },
        { number: 2, state: 'closed' },
        { number: 'three', state: 'open' },
        null,
      ],
    }));

    expect(expectOk(await client.listPullRequestsForCommit(repo, 'abc123'))).toEqual([1]);
    expect(requests[0]?.url.pathname).toEqual('/repos/owner/repo/commits/abc123/pulls');
  });

  it('rejects a non-array payload', async () => {
    const { client } = createClient(() => ({ body: {} }));

    expect((await client.listPullRequestsForCommit(repo, 'abc123')).ok).toBe(false);
  });
});

describe('compareCommits', () => {
  it('parses ahead and behind counts', async () => {
    const { client, requests } = createClient(() => ({ body: { behind_by: 3, ahead_by: 1 } }));

    expect(expectOk(await client.compareCommits(repo, 'main', 'feature'))).toEqual({
      behindBy: 3,
      aheadBy: 1,
    });
    expect(requests[0]?.url.pathname).toEqual('/repos/owner/repo/compare/main...feature');
  });

  it('rejects missing counts and non-object payloads', async () => {
    const missing = createClient(() => ({ body: { behind_by: 3 } }));
    const scalar = createClient(() => ({ body: null }));

    expect((await missing.client.compareCommits(repo, 'main', 'feature')).ok).toBe(false);
    expect((await scalar.client.compareCommits(repo, 'main', 'feature')).ok).toBe(false);
  });
});

describe('mergePullRequest', () => {
  it('sends the head sha and configured method, replacing the default message', async () => {
    const { client, requests } = createClient(() => ({ body: { merged: true, sha: 'merge-sha' } }));

    const result = expectOk(
      await client.mergePullRequest({
        repo,
        number: 7,
        sha: 'head-sha',
        method: 'squash',
        commitTitle: 'My change',
      }),
    );

    expect(result).toEqual({ merged: true });
    expect(requests[0]?.method).toEqual('PUT');
    expect(requests[0]?.url.pathname).toEqual('/repos/owner/repo/pulls/7/merge');
    expect(requests[0]?.body).toEqual({
      sha: 'head-sha',
      merge_method: 'squash',
      commit_title: 'My change',
      commit_message: '',
    });
  });

  it('omits the commit title in automatic mode', async () => {
    const { client, requests } = createClient(() => ({ body: { merged: false } }));

    expect(
      expectOk(
        await client.mergePullRequest({
          repo,
          number: 7,
          sha: 'head-sha',
          method: 'merge',
          commitTitle: undefined,
        }),
      ),
    ).toEqual({ merged: false });
    expect(requests[0]?.body).toEqual({
      sha: 'head-sha',
      merge_method: 'merge',
      commit_message: '',
    });
  });

  it('rejects a response without a merged flag', async () => {
    const { client } = createClient(() => ({ body: { sha: 'merge-sha' } }));

    expect(
      (
        await client.mergePullRequest({
          repo,
          number: 7,
          sha: 'head-sha',
          method: 'merge',
          commitTitle: undefined,
        })
      ).ok,
    ).toBe(false);
  });
});

describe('mergeBaseIntoHead', () => {
  it('treats a no-content response as up to date', async () => {
    const { client, requests } = createClient(() => ({ status: 204 }));

    expect(
      expectOk(await client.mergeBaseIntoHead({ repo, headRef: 'feature', baseRef: 'main' })),
    ).toEqual({ kind: 'up_to_date' });
    expect(requests[0]?.method).toEqual('POST');
    expect(requests[0]?.url.pathname).toEqual('/repos/owner/repo/merges');
    expect(requests[0]?.body).toEqual({ base: 'feature', head: 'main' });
  });

  it('returns the merge commit sha', async () => {
    const { client } = createClient(() => ({ status: 201, body: { sha: 'merge-sha' } }));

    expect(
      expectOk(await client.mergeBaseIntoHead({ repo, headRef: 'feature', baseRef: 'main' })),
    ).toEqual({ kind: 'merged', sha: 'merge-sha' });
  });

  it('rejects a merge response without a sha', async () => {
    const { client } = createClient(() => ({ status: 201, body: {} }));

    expect((await client.mergeBaseIntoHead({ repo, headRef: 'feature', baseRef: 'main' })).ok).toBe(
      false,
    );
  });

  it('classifies merge request errors', async () => {
    const { client } = createClient(() => ({ status: 404, body: { message: 'Not Found' } }));

    expect(await client.mergeBaseIntoHead({ repo, headRef: 'feature', baseRef: 'main' })).toEqual({
      ok: false,
      error: { kind: 'not_found', message: 'Not Found' },
    });
  });
});

describe('error classification', () => {
  it.each([
    [404, 'Not Found', 'not_found'],
    [403, 'API rate limit exceeded', 'rate_limited'],
    [403, 'Resource not accessible by integration', 'forbidden'],
    [405, 'Method Not Allowed', 'conflict'],
    [409, 'Merge conflict', 'conflict'],
    [422, 'Validation Failed', 'conflict'],
    [429, 'Too many requests', 'rate_limited'],
    [500, 'Internal Server Error', 'server'],
    [400, 'Bad Request', 'server'],
  ] as const)('classifies HTTP %i as %s', async (status, message, kind) => {
    const { client } = createClient(() => ({ status, body: { message } }));

    const result = await client.getPullRequest(repo, 7);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.kind).toEqual(kind);
  });

  it('classifies a thrown error without a status as a network failure', async () => {
    const fakeOctokit = {
      rest: {
        pulls: {
          get: async () => {
            throw new Error('socket hang up');
          },
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>;
    const client = createGitHubClient(fakeOctokit);

    expect(await client.getPullRequest(repo, 7)).toEqual({
      ok: false,
      error: { kind: 'network', message: 'socket hang up' },
    });
  });
});
