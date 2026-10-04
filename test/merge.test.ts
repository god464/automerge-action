import { beforeEach, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

import { merge } from '../lib/merge.js';
import { createConfig } from '../lib/common.js';
import type { MergeContext } from '../lib/types.js';
import { pullRequest } from './common.js';

interface MockOctokit {
  pulls: { merge: Mock; get: () => void };
  repos: { getBranchRules: Mock; getBranchProtection: Mock };
  git: { deleteRef: Mock };
}

let octokit: MockOctokit;
let mergeMethod: string | undefined;

beforeEach(() => {
  mergeMethod = undefined;
  octokit = {
    pulls: {
      merge: vi.fn<(params: { merge_method: string }) => void>(({ merge_method }) => {
        mergeMethod = merge_method;
      }),
      get: vi.fn<() => void>(),
    },
    repos: {
      getBranchRules: vi.fn<() => Promise<{ data: Array<{ type: string }> }>>(async () => ({
        data: [],
      })),
      // ruleset-only branches have no classic branch protection
      getBranchProtection: vi.fn<() => Promise<unknown>>(async () => {
        throw new Error('Branch not protected');
      }),
    },
    git: { deleteRef: vi.fn<() => Promise<unknown>>(async () => ({})) },
  };
});

test('MERGE_COMMIT_MESSAGE with nested custom fields', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.title = "This is the PR's title";
  pr.user = { login: 'author' };

  const config = createConfig({
    MERGE_COMMIT_MESSAGE: '{pullRequest.title} @{pullRequest.user.login}',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual('merged');

  // THEN
  expect(octokit.pulls.merge).toHaveBeenCalledWith(
    expect.objectContaining({
      commit_title: "This is the PR's title @author",
      commit_message: '',
      pull_number: 1,
      repo: 'repository',
      sha: '2c3b4d5',
    }),
  );
});

test('MERGE_COMMIT_MESSAGE_REGEX can be used to cut PR body', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.body = [
    'PSA: This is the meaty part of the PR body.',
    'It also matches newlines.',
    '',
    '----',
    '',
    'Here is a silly license agreement.',
  ].join('\n');

  const config = createConfig({
    MERGE_COMMIT_MESSAGE: 'pull-request-title-and-description',
    MERGE_COMMIT_MESSAGE_REGEX: 'PSA:(.*)^----',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual('merged');

  // THEN
  expect(octokit.pulls.merge).toHaveBeenCalledWith(
    expect.objectContaining({
      commit_title:
        'Update README\n\nThis is the meaty part of the PR body.\nIt also matches newlines.',
      commit_message: '',
      pull_number: 1,
      repo: 'repository',
      sha: '2c3b4d5',
    }),
  );
});

test('Throw if MERGE_COMMIT_MESSAGE_REGEX is invalid', async () => {
  // GIVEN
  const pr = pullRequest();
  const config = createConfig({
    MERGE_COMMIT_MESSAGE: 'pull-request-title-and-description',
    MERGE_COMMIT_MESSAGE_REGEX: '.*',
  });

  // WHEN
  await expect(merge({ config, octokit } as unknown as MergeContext, pr, 0)).rejects.toThrow(
    'capturing subgroup',
  );
});

test('MERGE_FILTER_AUTHOR can be used to auto merge based on author', async () => {
  // GIVEN
  const pr = pullRequest();
  const author = 'minime';
  const user = { login: author };
  pr.user = user;

  const config = createConfig({
    MERGE_COMMIT_MESSAGE: 'pull-request-title-and-description',
    MERGE_FILTER_AUTHOR: author,
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual('merged');
});

test('MERGE_FILTER_AUTHOR when not set should not affect anything', async () => {
  // GIVEN
  const pr = pullRequest();
  const author = 'minime';
  const user = { login: author };
  pr.user = user;

  const config = createConfig({ MERGE_COMMIT_MESSAGE: 'pull-request-title-and-description' });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual('merged');
});

test('MERGE_FILTER_AUTHOR when set but do not match current author should not merge', async () => {
  // GIVEN
  const pr = pullRequest();
  const author = 'notminime';
  const user = { login: author };
  pr.user = user;

  const config = createConfig({
    MERGE_COMMIT_MESSAGE: 'pull-request-title-and-description',
    MERGE_FILTER_AUTHOR: 'minime',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual(
    'author_filtered',
  );
});

test('Merge method can be set by env variable', async () => {
  // GIVEN
  const pr = pullRequest();

  const config = createConfig({ MERGE_METHOD: 'rebase' });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual('merged');
  expect(mergeMethod).toEqual('rebase');
});

test('Merge method can be set by a merge method label', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.labels = [{ name: 'autosquash' }, { name: 'reallyautomerge' }];

  const config = createConfig({
    MERGE_METHOD_LABELS: 'automerge=merge,autosquash=squash,autorebase=rebase',
    MERGE_METHOD: 'merge',
    MERGE_LABELS: 'reallyautomerge',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual('merged');
  expect(mergeMethod).toEqual('squash');
});

test('Merge method can be required', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.labels = [{ name: 'autosquash' }];

  const config = createConfig({
    MERGE_METHOD_LABELS: 'automerge=merge,autosquash=squash,autorebase=rebase',
    MERGE_METHOD_LABEL_REQUIRED: 'true',
    MERGE_METHOD: 'merge',
    MERGE_LABELS: '',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual('merged');
  expect(mergeMethod).toEqual('squash');
});

test('Missing require merge method skips PR', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.labels = [{ name: 'mergeme' }];

  const config = createConfig({
    MERGE_METHOD_LABELS: 'automerge=merge,autosquash=squash,autorebase=rebase',
    MERGE_METHOD_LABEL_REQUIRED: 'true',
    MERGE_METHOD: 'merge',
    MERGE_LABELS: 'mergeme',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual('skipped');
});

test("Merge method doesn't have to be required", async () => {
  // GIVEN
  const pr = pullRequest();
  pr.labels = [{ name: 'mergeme' }];

  const config = createConfig({
    MERGE_METHOD_LABELS: 'automerge=merge,autosquash=squash,autorebase=rebase',
    MERGE_METHOD_LABEL_REQUIRED: 'false',
    MERGE_METHOD: 'merge',
    MERGE_LABELS: 'mergeme',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr)).toEqual('merged');
  expect(mergeMethod).toEqual('merge');
});

test('Multiple merge method labels throw an error', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.labels = [{ name: 'automerge' }, { name: 'autosquash' }];

  const config = createConfig({
    MERGE_METHOD_LABELS: 'automerge=merge,autosquash=squash,autorebase=rebase',
    MERGE_METHOD_LABEL_REQUIRED: 'true',
    MERGE_METHOD: 'merge',
  });

  // WHEN
  await expect(merge({ config, octokit } as unknown as MergeContext, pr, 0)).rejects.toThrow(
    'merge method labels',
  );
});

test('Base branch is listed then PR is merged', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.labels = [{ name: 'mergeme' }];

  const config = createConfig({
    MERGE_METHOD_LABELS: 'automerge=merge,autosquash=squash,autorebase=rebase',
    MERGE_METHOD_LABEL_REQUIRED: 'false',
    MERGE_METHOD: 'merge',
    MERGE_LABELS: 'mergeme',
    BASE_BRANCHES: 'main,master,dev',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr, 0)).toEqual('merged');
});

test('Base branch not listed then PR is skipped', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.labels = [{ name: 'mergeme' }];

  const config = createConfig({
    MERGE_METHOD_LABELS: 'automerge=merge,autosquash=squash,autorebase=rebase',
    MERGE_METHOD_LABEL_REQUIRED: 'false',
    MERGE_METHOD: 'merge',
    MERGE_LABELS: 'mergeme',
    BASE_BRANCHES: 'main,dev',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr, 0)).toEqual('skipped');
});

test('Unmergeable pull request fails action with non-zero exit code', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.mergeable_state = 'blocked';
  const config = createConfig({ MERGE_ERROR_FAIL: 'true' });
  octokit.pulls.get = async () => ({ data: pr });

  // Reduce retry wait period to 1ms to prevent test timeout
  config.mergeRetrySleep = 1;

  // WHEN
  const mockExit = vi.spyOn(process, 'exit').mockImplementationOnce((statusCode) => {
    throw new Error(`process.exit was called with status code: ${statusCode}`);
  });

  await expect(merge({ config, octokit } as unknown as MergeContext, pr, 0)).rejects.toThrow(
    'process.exit was called with status code: 1',
  );
  expect(mockExit).toHaveBeenCalledWith(1);
});

test('MERGE_DELETE_BRANCH does not delete a branch restricted by a ruleset', async () => {
  // GIVEN
  const pr = pullRequest();
  const config = createConfig({ MERGE_DELETE_BRANCH: 'true' });
  octokit.repos.getBranchRules.mockResolvedValueOnce({ data: [{ type: 'deletion' }] });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr, 0)).toEqual('merged');

  // THEN
  expect(octokit.git.deleteRef).not.toHaveBeenCalled();
});

test('MERGE_DELETE_BRANCH deletes a branch when no ruleset restricts deletions', async () => {
  // GIVEN
  const pr = pullRequest();
  const config = createConfig({ MERGE_DELETE_BRANCH: 'true' });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr, 0)).toEqual('merged');

  // THEN
  expect(octokit.git.deleteRef).toHaveBeenCalledWith(
    expect.objectContaining({ ref: 'heads/patch-1' }),
  );
});

test('MERGE_DELETE_BRANCH never deletes branches from external repositories', async () => {
  // GIVEN
  const pr = pullRequest();
  pr.head.repo.full_name = 'someone-else/repository';
  const config = createConfig({ MERGE_DELETE_BRANCH: 'true' });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr, 0)).toEqual('merged');

  // THEN
  expect(octokit.repos.getBranchRules).not.toHaveBeenCalled();
  expect(octokit.git.deleteRef).not.toHaveBeenCalled();
});

test('MERGE_DELETE_BRANCH does not delete branches in the filter list', async () => {
  // GIVEN
  const pr = pullRequest();
  const config = createConfig({
    MERGE_DELETE_BRANCH: 'true',
    MERGE_DELETE_BRANCH_FILTER: 'other,patch-1',
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr, 0)).toEqual('merged');

  // THEN
  expect(octokit.repos.getBranchRules).not.toHaveBeenCalled();
  expect(octokit.git.deleteRef).not.toHaveBeenCalled();
});

test('MERGE_DELETE_BRANCH does not delete a branch protected against deletions', async () => {
  // GIVEN
  const pr = pullRequest();
  const config = createConfig({ MERGE_DELETE_BRANCH: 'true' });
  octokit.repos.getBranchProtection.mockResolvedValueOnce({
    data: { allow_deletions: { enabled: false } },
  });

  // WHEN
  expect(await merge({ config, octokit } as unknown as MergeContext, pr, 0)).toEqual('merged');

  // THEN
  expect(octokit.git.deleteRef).not.toHaveBeenCalled();
});
