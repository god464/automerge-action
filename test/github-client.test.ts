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
  readonly headers?: Readonly<Record<string, string>>;
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
      headers: { 'content-type': 'application/json', ...response.headers },
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
    labels: [{ name: 'automerge' }, { name: 'ready' }],
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

  it.each([
    ['labels is not an array', { labels: 'automerge' }],
    ['a label has no name', { labels: [{ name: 'automerge' }, { color: 'red' }] }],
    ['mergeable_state is not a string', { mergeable_state: 42 }],
    ['mergeable is not a boolean', { mergeable: 'true' }],
    ['state is unknown', { state: 'locked' }],
    ['title is missing', { title: undefined }],
    ['number is missing', { number: undefined }],
  ] as const)('rejects the response when %s', async (_label, override) => {
    const { client } = createClient(() => ({ body: pullRequestPayload(override) }));

    expect(await client.getPullRequest(repo, 7)).toEqual({
      ok: false,
      error: { kind: 'invalid_response', message: 'unexpected GitHub API response shape' },
    });
  });

  it('accepts a boolean or null mergeable value', async () => {
    let call = 0;
    const { client } = createClient(() => {
      call += 1;
      return { body: pullRequestPayload({ mergeable: call === 1 ? false : null }) };
    });

    expect(expectOk(await client.getPullRequest(repo, 7)).mergeable).toBe(false);
    expect(expectOk(await client.getPullRequest(repo, 7)).mergeable).toBeNull();
  });
});

describe('listOpenPullRequests', () => {
  it('requests one page with the base filter and parses snapshots', async () => {
    const { client, requests } = createClient(() => ({
      body: [pullRequestPayload(), pullRequestPayload({ number: 8, state: 'closed' })],
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

  it('accepts a legitimate empty list', async () => {
    const { client } = createClient(() => ({ body: [] }));

    expect(
      expectOk(await client.listOpenPullRequests(repo, { base: 'main', perPage: 10 })),
    ).toEqual([]);
  });

  it.each([
    ['a non-array payload', { message: 'nope' }],
    ['a null element', [pullRequestPayload(), null]],
    ['a malformed element', [pullRequestPayload(), { number: 'seven' }]],
    ['an unknown state in an element', [pullRequestPayload({ state: 'locked' })]],
  ] as const)('rejects %s instead of returning a partial list', async (_label, body) => {
    const { client } = createClient(() => ({ body }));

    expect(await client.listOpenPullRequests(repo, { base: 'main', perPage: 10 })).toEqual({
      ok: false,
      error: { kind: 'invalid_response', message: 'unexpected GitHub API response shape' },
    });
  });
});

describe('listPullRequestsForCommit', () => {
  it('returns open pull request numbers and ignores closed entries', async () => {
    const { client, requests } = createClient(() => ({
      body: [
        { number: 1, state: 'open' },
        { number: 2, state: 'closed' },
      ],
    }));

    expect(expectOk(await client.listPullRequestsForCommit(repo, 'abc123'))).toEqual([1]);
    expect(requests[0]?.url.pathname).toEqual('/repos/owner/repo/commits/abc123/pulls');
  });

  it.each([
    ['a non-array payload', {}],
    ['a malformed element', [{ number: 'three', state: 'open' }]],
    ['a null element', [null]],
    ['an unknown state', [{ number: 1, state: 'locked' }]],
    ['a missing number', [{ state: 'open' }]],
  ] as const)('rejects %s', async (_label, body) => {
    const { client } = createClient(() => ({ body }));

    expect(await client.listPullRequestsForCommit(repo, 'abc123')).toEqual({
      ok: false,
      error: { kind: 'invalid_response', message: 'unexpected GitHub API response shape' },
    });
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

  it('rejects missing, negative, non-integer, and non-object payloads', async () => {
    for (const body of [
      { behind_by: 3 },
      { behind_by: -1, ahead_by: 1 },
      { behind_by: 1, ahead_by: 1.5 },
      { behind_by: '1', ahead_by: 1 },
      null,
    ]) {
      const { client } = createClient(() => ({ body }));

      expect(await client.compareCommits(repo, 'main', 'feature')).toEqual({
        ok: false,
        error: { kind: 'invalid_response', message: 'unexpected GitHub API response shape' },
      });
    }
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
    [401, 'Bad credentials', 'forbidden'],
    [403, 'Resource not accessible by integration', 'forbidden'],
    [405, 'Method Not Allowed', 'conflict'],
    [409, 'Head branch was modified', 'conflict'],
    [422, 'Validation Failed', 'validation'],
    [400, 'Bad Request', 'validation'],
    [429, 'Too many requests', 'rate_limited'],
    [500, 'Internal Server Error', 'server'],
  ] as const)('classifies HTTP %i as %s', async (status, message, kind) => {
    const { client } = createClient(() => ({ status, body: { message } }));

    const result = await client.getPullRequest(repo, 7);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.kind).toEqual(kind);
  });

  it('recognizes a rate limit from response headers even without a message hint', async () => {
    const { client } = createClient(() => ({
      status: 403,
      body: { message: 'Forbidden' },
      headers: { 'x-ratelimit-remaining': '0' },
    }));

    expect(await client.getPullRequest(repo, 7)).toEqual({
      ok: false,
      error: { kind: 'rate_limited', message: 'Forbidden' },
    });
  });

  it('recognizes a secondary rate limit from a retry-after header', async () => {
    const { client } = createClient(() => ({
      status: 403,
      body: { message: 'Forbidden' },
      headers: { 'retry-after': '60' },
    }));

    expect((await client.getPullRequest(repo, 7)).ok ? null : 'rate_limited').toEqual(
      'rate_limited',
    );
  });

  it('keeps the message fallback for rate limits reported without headers', async () => {
    const { client } = createClient(() => ({
      status: 403,
      body: { message: 'API rate limit exceeded for user' },
    }));

    expect((await client.getPullRequest(repo, 7)).ok ? null : 'rate_limited').toEqual(
      'rate_limited',
    );
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
