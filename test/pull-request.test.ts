import { describe, expect, it } from 'vitest';

import { type BranchRef, compareHeadSpec, repoFullName, sameRepo } from '@/domain/pull-request';

const base = { owner: 'Owner', repo: 'Repo' };
const sameRepoBranch: BranchRef = {
  ref: 'feature',
  sha: 'sha',
  repo: { owner: 'owner', repo: 'repo' },
};
const forkBranch: BranchRef = {
  ref: 'feature',
  sha: 'sha',
  repo: { owner: 'alice', repo: 'repo' },
};

describe('RepoRef helpers', () => {
  it('formats a repository full name', () => {
    expect(repoFullName({ owner: 'alice', repo: 'repo' })).toEqual('alice/repo');
  });

  it('compares repositories case-insensitively', () => {
    expect(sameRepo(base, { owner: 'owner', repo: 'repo' })).toBe(true);
    expect(sameRepo(base, { owner: 'alice', repo: 'repo' })).toBe(false);
  });

  it('uses the bare ref for a same-repository head', () => {
    expect(compareHeadSpec(base, sameRepoBranch)).toEqual('feature');
  });

  it('qualifies a fork head with its owner', () => {
    expect(compareHeadSpec(base, forkBranch)).toEqual('alice:feature');
  });

  it('falls back to the bare ref when the head repository is missing', () => {
    expect(compareHeadSpec(base, { ref: 'feature', sha: 'sha', repo: null })).toEqual('feature');
  });
});
