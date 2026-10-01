import { expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

import * as api from '../lib/api';
import { createConfig } from '../lib/common';
import type { Context, EventData, PullRequest } from '../lib/types';
import { pullRequest } from './common';

interface MockOctokit {
  pulls: { list: Mock; merge: Mock; listReviews: Mock | symbol };
  paginate: Mock;
}

test('forked PR check_suite/check_run updates are handled', async () => {
  // GIVEN
  const head_sha = '1234abcd';
  const pr = pullRequest();
  pr.labels = [{ name: 'automerge' }];
  pr.head.sha = head_sha;

  const config = createConfig({});

  let merged = false;
  const octokit: MockOctokit = {
    pulls: {
      list: vi.fn<() => { data: PullRequest[] }>(() => ({ data: [pr] })),
      merge: vi.fn<() => void>(() => {
        merged = true;
      }),
      listReviews: vi.fn<() => { data: never[] }>(() => ({ data: [] })),
    },
    paginate: vi.fn<() => unknown[]>(() => []),
  };

  const event: EventData = {
    action: 'completed',
    repository: { owner: { login: 'other-username' }, name: 'repository' },
    check_suite: { conclusion: 'success', head_sha, pull_requests: [] },
  };

  // WHEN
  await api.executeGitHubAction({ config, octokit } as unknown as Context, 'check_suite', event, {
    setOutput: vi.fn<(name: string, value: unknown) => void>(),
  });
  expect(merged).toEqual(true);
});

test('only merge PRs with required approvals', async () => {
  // GIVEN
  const head_sha = '1234abcd';
  const pr = pullRequest();
  pr.labels = [{ name: 'automerge' }];
  pr.head.sha = head_sha;

  const config = createConfig({});
  config.mergeRequiredApprovals = 2; // let's only merge, if there are two independent approvals

  let merged = false;
  const octokit: MockOctokit = {
    pulls: {
      list: vi.fn<() => { data: PullRequest[] }>(() => ({ data: [pr] })),
      merge: vi.fn<() => void>(() => {
        merged = true;
      }),
      listReviews: Symbol('listReviews'),
    },
    paginate: vi.fn<() => unknown[]>(() => []),
  };

  const event: EventData = {
    action: 'completed',
    repository: { owner: { login: 'other-username' }, name: 'repository' },
    check_suite: { conclusion: 'success', head_sha, pull_requests: [] },
  };

  const context = { config, octokit } as unknown as Context;
  const outputs = { setOutput: vi.fn<(name: string, value: unknown) => void>() };

  // WHEN
  await api.executeGitHubAction(context, 'check_suite', event, outputs);
  expect(merged).toEqual(false); // if there's no approval, it should fail

  merged = false;
  octokit.paginate.mockReturnValueOnce([
    { state: 'APPROVED', user: { login: 'approval_user' } },
    { state: 'APPROVED', user: { login: 'approval_user2' } },
  ]);

  // WHEN
  await api.executeGitHubAction(context, 'check_suite', event, outputs);
  expect(merged).toEqual(true); // if there are two approvals, it should succeed

  merged = false;
  octokit.paginate.mockReturnValueOnce([
    { state: 'APPROVED', user: { login: 'approval_user' } },
    { state: 'APPROVED', user: { login: 'approval_user' } },
  ]);

  // WHEN a user has given
  await api.executeGitHubAction(context, 'check_suite', event, outputs);
  expect(merged).toEqual(false); // if there are only two approvals from the same user, it should fail
});
