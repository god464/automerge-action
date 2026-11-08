import type { Config } from '../src/config/config.js';
import type { PullRequestSnapshot } from '../src/domain/pull-request.js';
import type { Result } from '../src/result.js';

export function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Expected ok result, got: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

export function config(overrides: Partial<Config> = {}): Config {
  return {
    githubToken: 'token',
    mergeLabels: { required: ['automerge'], blocking: [] },
    mergeMethod: 'merge',
    mergeCommitMessage: 'automatic',
    updateLabels: { required: ['automerge'], blocking: [] },
    updateMethod: 'merge',
    labelConflicts: [],
    ...overrides,
  };
}

export function pullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    repo: { owner: 'owner', repo: 'repo' },
    number: 1,
    title: 'Update README',
    state: 'open',
    merged: false,
    draft: false,
    mergeable: true,
    mergeableState: 'clean',
    labels: ['automerge'],
    head: { ref: 'feature', sha: 'head-sha', repoFullName: 'owner/repo' },
    base: { ref: 'main', sha: 'base-sha', repoFullName: 'owner/repo' },
    ...overrides,
  };
}
