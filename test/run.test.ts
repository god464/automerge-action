import { describe, expect, it } from 'vitest';

import type { PullRequestSnapshot } from '../src/domain/pull-request';
import type { ParsedEvent } from '../src/events/event';
import { err, ok } from '../src/result';
import type { ProcessDeps } from '../src/run/process-pull-request';
import { processPullRequest } from '../src/run/process-pull-request';
import { runFromEvent } from '../src/run/run';
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
      listOpenPullRequests: async () => ok([{ number: 1 }, { number: 2 }]),
      mergeBaseIntoHead: async () => ok({ kind: 'merged', sha: 'new-head' }),
    });

    const result = await processPullRequest(deps({ client }), repo, 1, 'update_and_merge');

    expect(result).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.listOpenPullRequests).toHaveLength(1);
    expect(client.calls.getPullRequest.map((call) => call.number)).toEqual([1, 2]);
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
    const client = sequenceClient([pullRequest({ mergeableState: 'behind' })], {
      listOpenPullRequests: async () => ok([{ number: 2 }]),
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
    expect(client.calls.mergeBaseIntoHead).toHaveLength(1);
    expect(client.calls.mergePullRequest).toHaveLength(0);
  });

  it('resolves status events by commit SHA', async () => {
    const client = sequenceClient([pullRequest()], {
      listPullRequestsForCommit: async () => ok([{ number: 3 }]),
    });
    const event: ParsedEvent = { kind: 'status', state: 'success', sha: 'commit-sha', repo };

    const report = await runFromEvent(deps({ client }), event);

    expect(report.primary).toEqual({ result: 'merged', pullRequestNumber: 3 });
    expect(client.calls.listPullRequestsForCommit.at(0)).toEqual({ repo, sha: 'commit-sha' });
    expect(client.calls.mergePullRequest).toHaveLength(1);
  });

  it('processes multiple pull requests and outputs the first result', async () => {
    const client = sequenceClient([pullRequest(), pullRequest()], {
      listPullRequestsForCommit: async () => ok([{ number: 1 }, { number: 2 }]),
    });
    const event: ParsedEvent = { kind: 'status', state: 'success', sha: 'commit-sha', repo };

    const report = await runFromEvent(deps({ client }), event);

    expect(report.all).toHaveLength(2);
    expect(report.primary).toEqual({ result: 'merged', pullRequestNumber: 1 });
    expect(client.calls.mergePullRequest).toHaveLength(2);
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
});
