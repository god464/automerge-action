import { describe, expect, it } from 'vitest';

import type { PullRequestSnapshot } from '@/domain/pull-request';
import type { ParsedEvent } from '@/events/event';
import { err, ok } from '@/result';
import type { ProcessDeps } from '@/run/process-pull-request';
import { processPullRequest } from '@/run/process-pull-request';
import { runFromEvent } from '@/run/run';

import { config, pullRequest } from './factories';
import {
  createFakeClient,
  createFakeLogger,
  createFakeSleep,
  createUnusedGitRunner,
  type FakeClientOptions,
} from './fakes';

const repo = { owner: 'owner', repo: 'repo' };

function sequenceClient(
  snapshots: readonly PullRequestSnapshot[],
  options: FakeClientOptions = {},
) {
  let index = 0;
  return createFakeClient({
    ...options,
    getPullRequest: async (nextRepo, number) => {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      if (snapshot == null) {
        throw new Error('no snapshot configured');
      }
      return ok({ ...snapshot, repo: nextRepo, number });
    },
  });
}

function deps(overrides: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    config: config(),
    client: createFakeClient(),
    logger: createFakeLogger(),
    git: createUnusedGitRunner(),
    sleep: async () => undefined,
    now: () => 0,
    cloneUrl: (repoFullName) => `/tmp/${repoFullName}`,
    ...overrides,
  };
}

describe('processPullRequest', () => {
  it('merges a clean pull request', async () => {
    const client = createFakeClient();
    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.mergePullRequest.at(0)).toEqual({
      repo,
      number: 1,
      sha: 'head-sha',
      method: 'merge',
      commitTitle: undefined,
    });
    expect(client.calls.compareCommits).toHaveLength(0);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(0);
  });

  it('updates other behind pull requests after a successful merge', async () => {
    const client = createFakeClient({
      getPullRequest: async (nextRepo, number) =>
        ok(
          pullRequest({
            repo: nextRepo,
            number,
            mergeableState: number === 2 ? 'behind' : 'clean',
          }),
        ),
      listOpenPullRequests: async () =>
        ok([pullRequest({ number: 1 }), pullRequest({ number: 2, mergeableState: 'behind' })]),
      mergeBaseIntoHead: async () => ok({ kind: 'merged', sha: 'new-head' }),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.listOpenPullRequests).toHaveLength(1);
    expect(client.calls.getPullRequest.map((call) => call.number)).toEqual([1]);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(1);
    expect(client.calls.mergePullRequest).toHaveLength(1);
  });

  it('updates a behind pull request before merging', async () => {
    const client = sequenceClient([pullRequest({ mergeableState: 'behind' }), pullRequest()], {
      mergeBaseIntoHead: async () => ok({ kind: 'merged', sha: 'new-head' }),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.mergeBaseIntoHead).toHaveLength(1);
    expect(client.calls.getPullRequest).toHaveLength(2);
    expect(client.calls.mergePullRequest).toHaveLength(1);
  });

  it('does not merge a blocked pull request that is not behind', async () => {
    const client = sequenceClient([pullRequest({ mergeableState: 'blocked' })]);

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'not_ready', pullRequestNumber: 1 });
    expect(client.calls.compareCommits).toHaveLength(1);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(0);
    expect(client.calls.mergePullRequest).toHaveLength(0);
  });

  it('updates a blocked pull request that is behind but does not merge it', async () => {
    const blocked = pullRequest({ mergeableState: 'blocked' });
    const client = sequenceClient([blocked, blocked], {
      compareCommits: async () => ok({ behindBy: 2, aheadBy: 0 }),
      mergeBaseIntoHead: async () => ok({ kind: 'merged', sha: 'new-head' }),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'not_ready', pullRequestNumber: 1 });
    expect(client.calls.compareCommits).toHaveLength(1);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(1);
    expect(client.calls.mergePullRequest).toHaveLength(0);
  });

  it('retries unknown mergeability a fixed number of times', async () => {
    const unknown = pullRequest({ mergeableState: 'unknown' });
    const client = sequenceClient([unknown]);
    const sleep = createFakeSleep();

    const result = await processPullRequest(
      deps({ client, sleep: sleep.sleep }),
      repo,
      1,
      'update_and_merge',
    );

    expect(result).toEqual({ result: 'not_ready', pullRequestNumber: 1 });
    expect(client.calls.getPullRequest).toHaveLength(3);
    expect(sleep.calls).toEqual([2000, 2000]);
    expect(client.calls.mergePullRequest).toHaveLength(0);
  });

  it('does not retry unknown mergeability in update_only mode', async () => {
    const client = createFakeClient({
      getPullRequest: async (nextRepo, number) =>
        ok(pullRequest({ repo: nextRepo, number, mergeableState: 'unknown' })),
    });
    const sleep = createFakeSleep();

    const result = await processPullRequest(
      deps({ client, sleep: sleep.sleep }),
      repo,
      1,
      'update_only',
    );

    expect(result).toEqual({ result: 'skipped', pullRequestNumber: undefined });
    expect(client.calls.getPullRequest).toHaveLength(1);
    expect(sleep.calls).toEqual([]);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(0);
  });

  it('continues after a failed merge-based update request', async () => {
    const client = sequenceClient([pullRequest({ mergeableState: 'behind' }), pullRequest()], {
      mergeBaseIntoHead: async () => err({ kind: 'conflict', message: 'cannot update' }),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.getPullRequest).toHaveLength(2);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(1);
    expect(client.calls.mergePullRequest).toHaveLength(1);
  });

  it('refreshes and merges when the update request reports up to date', async () => {
    const client = sequenceClient([pullRequest({ mergeableState: 'behind' }), pullRequest()], {
      mergeBaseIntoHead: async () => ok({ kind: 'up_to_date' }),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.getPullRequest).toHaveLength(2);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(1);
  });

  it.each([
    ['already up to date', 'head-sha'],
    ['updated', 'new-sha'],
  ] as const)('handles a rebase that is %s', async (_label, newHead) => {
    const client = sequenceClient([pullRequest({ mergeableState: 'behind' }), pullRequest()]);
    const git = {
      run: async (_cwd: string, args: readonly string[]) => {
        if (['clone', 'fetch', 'rebase', 'push'].includes(args[0] ?? ''))
          return ok({ stdout: '', exitCode: 0 });
        if (args[0] === 'merge-base') return ok({ stdout: 'base-sha', exitCode: 0 });
        if (args[0] === 'rev-list') return ok({ stdout: '', exitCode: 0 });
        if (args[0] === 'show-ref')
          return ok({ stdout: args.includes('/HEAD') ? newHead : 'onto-sha', exitCode: 0 });
        throw new Error(`unexpected git command: ${args.join(' ')}`);
      },
    };

    const result = await processPullRequest(
      deps({ client, git, config: config({ updateMethod: 'rebase' }) }),
      repo,
      1,
      'update_and_merge',
    );

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.mergePullRequest).toHaveLength(1);
  });

  it('continues after a failed rebase update', async () => {
    const client = sequenceClient([pullRequest({ mergeableState: 'behind' }), pullRequest()]);
    const git = {
      run: async () =>
        err({ kind: 'unexpected_exit' as const, command: 'git clone', exitCode: 1, stderr: '' }),
    };

    const result = await processPullRequest(
      deps({ client, git, config: config({ updateMethod: 'rebase' }) }),
      repo,
      1,
      'update_and_merge',
    );

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.mergePullRequest).toHaveLength(1);
  });

  it('does not update a blocked pull request when the comparison fails', async () => {
    const client = createFakeClient({
      getPullRequest: async (nextRepo, number) =>
        ok(pullRequest({ repo: nextRepo, number, mergeableState: 'blocked' })),
      compareCommits: async () => err({ kind: 'server', status: 500, message: 'boom' }),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'not_ready', pullRequestNumber: 1 });
    expect(client.calls.mergeBaseIntoHead).toHaveLength(0);
  });

  it('reports a merge failure when GitHub accepts the request without merging', async () => {
    const client = createFakeClient({ mergePullRequest: async () => ok({ merged: false }) });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'merge_failed', pullRequestNumber: 1 });
  });

  it('does not merge when refreshing after an update fails', async () => {
    let gets = 0;
    const client = createFakeClient({
      getPullRequest: async (nextRepo, number) => {
        gets += 1;
        return gets === 1
          ? ok(pullRequest({ repo: nextRepo, number, mergeableState: 'behind' }))
          : err({ kind: 'server', status: 500, message: 'boom' });
      },
      mergeBaseIntoHead: async () => ok({ kind: 'merged', sha: 'new-head' }),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'not_ready', pullRequestNumber: 1 });
    expect(client.calls.mergePullRequest).toHaveLength(0);
  });

  it('warns when mergeability has an unrecognized state', async () => {
    const client = createFakeClient({
      getPullRequest: async (nextRepo, number) =>
        ok(pullRequest({ repo: nextRepo, number, mergeableState: 'other' })),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'not_ready', pullRequestNumber: 1 });
  });

  it('skips pull requests that cannot be fetched', async () => {
    const client = createFakeClient({
      getPullRequest: async () => err({ kind: 'not_found', message: 'missing' }),
    });

    expect(await processPullRequest(deps({ client }), repo, 1, 'update_and_merge')).toEqual({
      result: 'skipped',
      pullRequestNumber: 1,
    });
  });

  it('keeps merging when listing other pull requests fails', async () => {
    const client = createFakeClient({
      listOpenPullRequests: async () => err({ kind: 'server', status: 500, message: 'boom' }),
    });

    expect(await processPullRequest(deps({ client }), repo, 1, 'update_and_merge')).toEqual({
      result: 'merged',
      pullRequestNumber: 1,
    });
  });

  it('caps the number of other pull requests updated after a merge', async () => {
    const listed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((number) =>
      pullRequest({ number, mergeableState: 'behind' }),
    );
    const client = createFakeClient({
      listOpenPullRequests: async () => ok(listed),
      mergeBaseIntoHead: async () => ok({ kind: 'merged', sha: 'new-head' }),
    });

    await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(client.calls.mergeBaseIntoHead).toHaveLength(10);
  });

  it('reports merge failure when the merge API fails', async () => {
    const client = createFakeClient({
      mergePullRequest: async () => err({ kind: 'conflict', message: 'not mergeable' }),
      getPullRequest: async (nextRepo, number) =>
        ok(pullRequest({ repo: nextRepo, number, merged: false })),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'merge_failed', pullRequestNumber: 1 });
    expect(client.calls.mergePullRequest).toHaveLength(1);
    expect(client.calls.getPullRequest).toHaveLength(2);
  });

  it('treats a concurrent merge as merged', async () => {
    let calls = 0;
    const client = createFakeClient({
      mergePullRequest: async () => err({ kind: 'conflict', message: 'race' }),
      getPullRequest: async (nextRepo, number) => {
        calls += 1;
        return ok(pullRequest({ repo: nextRepo, number, merged: calls > 1 }));
      },
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
  });

  it('keeps update and merge label filters independent', async () => {
    const client = createFakeClient();
    const result = await processPullRequest(
      deps({
        client,
        config: config({
          updateLabels: { required: ['update-me'], blocking: [] },
          mergeLabels: { required: ['automerge'], blocking: [] },
        }),
      }),
      repo,
      1,
      'update_and_merge',
    );

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.compareCommits).toHaveLength(0);
    expect(client.calls.mergePullRequest).toHaveLength(1);
  });

  it('skips merging when merge labels do not match', async () => {
    const client = createFakeClient();
    const result = await processPullRequest(
      deps({ client, config: config({ mergeLabels: { required: ['merge-me'], blocking: [] } }) }),
      repo,
      1,
      'update_and_merge',
    );

    expect(result).toEqual({ result: 'skipped', pullRequestNumber: 1 });
    expect(client.calls.mergePullRequest).toHaveLength(0);
  });
});

describe('runFromEvent', () => {
  it('updates pull requests based on a pushed base branch without merging', async () => {
    const client = createFakeClient({
      listOpenPullRequests: async () => ok([pullRequest({ number: 2, mergeableState: 'behind' })]),
      mergeBaseIntoHead: async () => ok({ kind: 'merged', sha: 'new-head' }),
    });
    const event: ParsedEvent = {
      kind: 'workflow_run',
      action: 'completed',
      conclusion: 'success',
      triggerEvent: 'push',
      headBranch: 'main',
      headSha: 'sha',
      repo,
      pullRequests: [],
    };

    const report = await runFromEvent(deps({ client }), event);

    expect(report.primary.result).toEqual('skipped');
    expect(client.calls.listOpenPullRequests.at(0)).toEqual({
      repo,
      filter: { base: 'main', perPage: 10 },
    });
    expect(client.calls.getPullRequest).toHaveLength(0);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(1);
    expect(client.calls.mergePullRequest).toHaveLength(0);
  });

  it('skips ineligible listed pull requests without fetching them', async () => {
    const client = createFakeClient({
      listOpenPullRequests: async () =>
        ok([pullRequest({ number: 2, labels: [], mergeableState: null })]),
    });
    const event: ParsedEvent = {
      kind: 'workflow_run',
      action: 'completed',
      conclusion: 'success',
      triggerEvent: 'push',
      headBranch: 'main',
      headSha: 'sha',
      repo,
      pullRequests: [],
    };

    await runFromEvent(deps({ client }), event);

    expect(client.calls.getPullRequest).toHaveLength(0);
    expect(client.calls.listOpenPullRequests).toHaveLength(1);
  });

  it('fetches a fresh snapshot when list results omit mergeability', async () => {
    const client = createFakeClient({
      listOpenPullRequests: async () =>
        ok([pullRequest({ number: 2, mergeable: null, mergeableState: null })]),
      getPullRequest: async (nextRepo, number) =>
        ok(pullRequest({ repo: nextRepo, number, mergeableState: 'behind' })),
      mergeBaseIntoHead: async () => ok({ kind: 'merged', sha: 'new-head' }),
    });
    const sleep = createFakeSleep();
    const event: ParsedEvent = {
      kind: 'workflow_run',
      action: 'completed',
      conclusion: 'success',
      triggerEvent: 'push',
      headBranch: 'main',
      headSha: 'sha',
      repo,
      pullRequests: [],
    };

    await runFromEvent(deps({ client, sleep: sleep.sleep }), event);

    expect(client.calls.getPullRequest.map((call) => call.number)).toEqual([2]);
    expect(sleep.calls).toEqual([]);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(1);
  });

  it('does not retry unknown mergeability for listed update-only pull requests', async () => {
    const client = createFakeClient({
      listOpenPullRequests: async () => ok([pullRequest({ number: 2, mergeableState: 'unknown' })]),
    });
    const sleep = createFakeSleep();
    const event: ParsedEvent = {
      kind: 'workflow_run',
      action: 'completed',
      conclusion: 'success',
      triggerEvent: 'push',
      headBranch: 'main',
      headSha: 'sha',
      repo,
      pullRequests: [],
    };

    await runFromEvent(deps({ client, sleep: sleep.sleep }), event);

    expect(client.calls.getPullRequest).toHaveLength(0);
    expect(client.calls.listOpenPullRequests).toHaveLength(1);
    expect(sleep.calls).toEqual([]);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(0);
  });

  it('deduplicates and caps listed update-only pull requests', async () => {
    const listed = [2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((number) =>
      pullRequest({
        number,
        mergeableState: 'behind',
        head: { ref: `feature-${number}`, sha: 'head-sha', repoFullName: 'owner/repo' },
      }),
    );
    const client = createFakeClient({
      listOpenPullRequests: async () => ok(listed),
      mergeBaseIntoHead: async () => ok({ kind: 'merged', sha: 'new-head' }),
    });
    const event: ParsedEvent = {
      kind: 'workflow_run',
      action: 'completed',
      conclusion: 'success',
      triggerEvent: 'push',
      headBranch: 'main',
      headSha: 'sha',
      repo,
      pullRequests: [],
    };

    await runFromEvent(deps({ client }), event);

    expect(client.calls.getPullRequest).toHaveLength(0);
    expect(client.calls.mergeBaseIntoHead.map((call) => call.headRef)).toEqual([
      'feature-2',
      'feature-3',
      'feature-4',
      'feature-5',
      'feature-6',
      'feature-7',
      'feature-8',
      'feature-9',
      'feature-10',
      'feature-11',
    ]);
  });

  it('resolves status events by commit SHA', async () => {
    const client = sequenceClient([pullRequest()], {
      listPullRequestsForCommit: async () => ok([3]),
    });
    const event: ParsedEvent = { kind: 'status', state: 'success', sha: 'commit-sha', repo };

    const report = await runFromEvent(deps({ client }), event);

    expect(report.primary).toEqual({ result: 'merged', pullRequestNumber: 3 });
    expect(client.calls.listPullRequestsForCommit.at(0)).toEqual({ repo, sha: 'commit-sha' });
    expect(client.calls.mergePullRequest).toHaveLength(1);
  });

  it('processes multiple pull requests and outputs the first result', async () => {
    const client = sequenceClient([pullRequest(), pullRequest()], {
      listPullRequestsForCommit: async () => ok([1, 2]),
    });
    const event: ParsedEvent = { kind: 'status', state: 'success', sha: 'commit-sha', repo };

    const report = await runFromEvent(deps({ client }), event);

    expect(report.all).toHaveLength(2);
    expect(report.primary).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.mergePullRequest.map((call) => call.number)).toEqual([1, 2]);
  });

  it('maps incomplete checks and unsupported events', async () => {
    const incomplete: ParsedEvent = {
      kind: 'workflow_run',
      action: 'requested',
      conclusion: null,
      triggerEvent: 'pull_request',
      headBranch: 'feature',
      headSha: 'sha',
      repo,
      pullRequests: [],
    };
    const unsupported: ParsedEvent = { kind: 'unsupported', eventName: 'push' };

    const incompleteReport = await runFromEvent(deps(), incomplete);
    const unsupportedReport = await runFromEvent(deps(), unsupported);

    expect(incompleteReport.primary.result).toEqual('not_ready');
    expect(unsupportedReport.primary.result).toEqual('skipped');
  });

  it('maps ignored pull requests to skipped', async () => {
    const event: ParsedEvent = {
      kind: 'pull_request',
      action: 'closed',
      repo,
      pullRequestNumber: 7,
    };

    const report = await runFromEvent(deps(), event);

    expect(report.primary).toEqual({ result: 'skipped', pullRequestNumber: undefined });
  });

  it('processes pull request events directly', async () => {
    const client = createFakeClient();
    const event: ParsedEvent = {
      kind: 'pull_request',
      action: 'labeled',
      repo,
      pullRequestNumber: 7,
    };

    const report = await runFromEvent(deps({ client }), event);

    expect(report.primary).toEqual({ result: 'merged', pullRequestNumber: 7 });
    expect(client.calls.getPullRequest).toHaveLength(1);
  });

  it('deduplicates pull requests attached to a workflow run', async () => {
    const client = createFakeClient();
    const event: ParsedEvent = {
      kind: 'workflow_run',
      action: 'completed',
      conclusion: 'success',
      triggerEvent: 'pull_request',
      headBranch: 'feature',
      headSha: 'sha',
      repo,
      pullRequests: [{ number: 1 }, { number: 1 }, { number: 2 }],
    };

    const report = await runFromEvent(deps({ client }), event);

    expect(report.all.map((result) => result.pullRequestNumber)).toEqual([1, 2]);
    expect(client.calls.mergePullRequest).toHaveLength(2);
  });

  it.each([
    ['list failure', err({ kind: 'server' as const, status: 500, message: 'boom' }), 'skipped'],
    ['empty list', ok([]), 'skipped'],
  ] as const)('handles commit pull request %s', async (_label, listing, expected) => {
    const client = createFakeClient({ listPullRequestsForCommit: async () => listing });
    const event: ParsedEvent = { kind: 'status', state: 'success', sha: 'commit-sha', repo };

    expect((await runFromEvent(deps({ client }), event)).primary.result).toEqual(expected);
    expect(client.calls.getPullRequest).toHaveLength(0);
  });

  it.each([
    ['list failure', err({ kind: 'server' as const, status: 500, message: 'boom' })],
    ['empty list', ok([])],
  ] as const)('handles base pull request %s', async (_label, listing) => {
    const client = createFakeClient({ listOpenPullRequests: async () => listing });
    const event: ParsedEvent = {
      kind: 'workflow_run',
      action: 'completed',
      conclusion: 'success',
      triggerEvent: 'push',
      headBranch: 'main',
      headSha: 'sha',
      repo,
      pullRequests: [],
    };

    const report = await runFromEvent(deps({ client }), event);

    expect(report.primary.result).toEqual('skipped');
    expect(client.calls.getPullRequest).toHaveLength(0);
    expect(client.calls.mergeBaseIntoHead).toHaveLength(0);
  });
});
