import type { PullRequest } from '../lib/types.js';

export function pullRequest(): PullRequest {
  return {
    number: 1,
    title: 'Update README',
    body: 'This PR updates the README',
    state: 'open',
    merged: false,
    mergeable_state: 'clean',
    labels: [{ name: 'automerge' }],
    user: { login: 'username' },
    head: {
      ref: 'patch-1',
      sha: '2c3b4d5',
      repo: { name: 'repository', full_name: 'username/repository', owner: { login: 'username' } },
    },
    base: {
      ref: 'master',
      sha: '45600fe',
      repo: { name: 'repository', full_name: 'username/repository', owner: { login: 'username' } },
    },
  };
}
