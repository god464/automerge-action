import { describe, expect, it } from 'vitest';

import { err, ok } from '@/result';
import { resolvePullRequestSnapshot } from '@/run/resolve-state';

import { expectOk, pullRequest } from './factories';
import { createFakeClient, createFakeLogger, createFakeSleep, createSequenceClient } from './fakes';

const repo = { owner: 'owner', repo: 'repo' };

describe('resolvePullRequestSnapshot', () => {
  it('returns the first snapshot when mergeability is known', async () => {
    const client = createSequenceClient([pullRequest()]);

    expect(
      expectOk(
        await resolvePullRequestSnapshot(
          { client, logger: createFakeLogger(), sleep: createFakeSleep().sleep },
          repo,
          1,
        ),
      ).mergeableState,
    ).toEqual('clean');
    expect(client.calls.getPullRequest).toHaveLength(1);
  });

  it('retries unknown mergeability until it becomes known', async () => {
    const client = createSequenceClient([
      pullRequest({ mergeableState: 'unknown' }),
      pullRequest({ mergeableState: null }),
      pullRequest({ mergeableState: 'clean' }),
    ]);
    const logger = createFakeLogger();
    const sleep = createFakeSleep();

    const snapshot = expectOk(
      await resolvePullRequestSnapshot({ client, logger, sleep: sleep.sleep }, repo, 4),
    );

    expect(snapshot.mergeableState).toEqual('clean');
    expect(client.calls.getPullRequest).toHaveLength(3);
    expect(sleep.calls).toEqual([2000, 2000]);
    expect(logger.debugMessages).toEqual([
      'Mergeability unknown for PR #4; retrying (2/3)',
      'Mergeability unknown for PR #4; retrying (3/3)',
    ]);
  });

  it('retries when mergeable is null even if the state looks clean', async () => {
    const client = createSequenceClient([
      pullRequest({ mergeable: null, mergeableState: 'clean' }),
      pullRequest({ mergeable: true, mergeableState: 'clean' }),
    ]);
    const sleep = createFakeSleep();

    const snapshot = expectOk(
      await resolvePullRequestSnapshot(
        { client, logger: createFakeLogger(), sleep: sleep.sleep },
        repo,
        4,
      ),
    );

    expect(snapshot.mergeable).toBe(true);
    expect(client.calls.getPullRequest).toHaveLength(2);
    expect(sleep.calls).toEqual([2000]);
  });

  it('gives up after the configured number of attempts', async () => {
    const client = createSequenceClient([pullRequest({ mergeableState: 'unknown' })], {
      repeatLast: true,
    });
    const logger = createFakeLogger();

    const snapshot = expectOk(
      await resolvePullRequestSnapshot({ client, logger, sleep: createFakeSleep().sleep }, repo, 4),
    );

    expect(snapshot.mergeableState).toEqual('unknown');
    expect(client.calls.getPullRequest).toHaveLength(3);
    expect(logger.debugMessages.at(-1)).toEqual(
      'Mergeability still unknown for PR #4 after 3 attempts',
    );
  });

  it('returns refresh errors', async () => {
    const client = createFakeClient({
      getPullRequest: async () =>
        client.calls.getPullRequest.length === 1
          ? ok(pullRequest({ mergeableState: 'unknown' }))
          : err({ kind: 'server', status: 500, message: 'boom' }),
    });
    const sleep = createFakeSleep();

    expect(
      await resolvePullRequestSnapshot(
        { client, logger: createFakeLogger(), sleep: sleep.sleep },
        repo,
        1,
      ),
    ).toEqual({ ok: false, error: { kind: 'server', status: 500, message: 'boom' } });
    expect(client.calls.getPullRequest).toHaveLength(2);
  });

  it('does not sleep or retry when the first request fails', async () => {
    const client = createFakeClient({
      getPullRequest: async () => err({ kind: 'not_found', message: 'missing' }),
    });
    const sleep = createFakeSleep();

    expect(
      await resolvePullRequestSnapshot(
        { client, logger: createFakeLogger(), sleep: sleep.sleep },
        repo,
        1,
      ),
    ).toEqual({ ok: false, error: { kind: 'not_found', message: 'missing' } });
    expect(sleep.calls).toEqual([]);
  });
});
