import { describe, expect, it } from 'vitest';

import { pullRequest } from './factories';
import { createSequenceClient } from './fakes';

const repo = { owner: 'owner', repo: 'repo' };

describe('createSequenceClient', () => {
  it('throws when more snapshots are requested than configured', async () => {
    const client = createSequenceClient([pullRequest()]);

    await client.getPullRequest(repo, 1);

    await expect(client.getPullRequest(repo, 2)).rejects.toThrow(
      'unexpected getPullRequest call #2: only 1 snapshot(s) configured',
    );
  });

  it('repeats the last snapshot only when explicitly configured', async () => {
    const client = createSequenceClient([pullRequest({ mergeableState: 'unknown' })], {
      repeatLast: true,
    });

    expect((await client.getPullRequest(repo, 1)).ok).toBe(true);
    expect((await client.getPullRequest(repo, 2)).ok).toBe(true);
    expect((await client.getPullRequest(repo, 3)).ok).toBe(true);
  });
});
