import {describe, expect, it} from 'vitest';
import {commitTitleFor, decideMerge} from '../src/domain/merge-decision';
import {classifyMergeableState, isBehind, shouldProbeBehind} from '../src/domain/merge-state';
import type {LabelFilter} from '../src/domain/labels';
import type {MergeableState} from '../src/domain/pull-request';
import {decideUpdate, updateEligibility} from '../src/domain/update-decision';
import {pullRequest} from './factories.js';

const filter: LabelFilter = { required: ['automerge'], blocking: ['wip'] };

describe('classifyMergeableState', () => {
  it.each(['clean', 'has_hooks', 'unstable'] as const)('treats %s as ready', (state) => {
    expect(classifyMergeableState(pullRequest({ mergeableState: state }))).toEqual({
      kind: 'ready',
    });
  });

  it.each(['blocked', 'behind', 'dirty', 'draft', 'other'] as const)(
    'treats %s as not ready',
    (state) => {
      expect(classifyMergeableState(pullRequest({ mergeableState: state }))).toEqual({
        kind: 'not_ready',
        reason: state,
      });
    },
  );

  it('treats unknown and missing states as unknown', () => {
    expect(classifyMergeableState(pullRequest({ mergeableState: 'unknown' }))).toEqual({
      kind: 'unknown',
    });
    expect(classifyMergeableState(pullRequest({ mergeableState: null }))).toEqual({
      kind: 'unknown',
    });
  });

  it('lets mergeable=false and draft=true win over the state', () => {
    expect(
      classifyMergeableState(pullRequest({ mergeableState: 'clean', mergeable: false })),
    ).toEqual({ kind: 'not_ready', reason: 'mergeable_false' });
    expect(classifyMergeableState(pullRequest({ mergeableState: 'clean', draft: true }))).toEqual({
      kind: 'not_ready',
      reason: 'draft',
    });
  });
});

describe('behind detection', () => {
  it('does not depend on whether checks are running or finished', () => {
    expect(isBehind(2, 'blocked')).toBe(true);
    expect(isBehind(2, 'clean')).toBe(true);
    expect(isBehind(0, 'blocked')).toBe(false);
    expect(isBehind(null, 'behind')).toBe(true);
  });

  it('only probes blocked/unstable pull requests', () => {
    expect(shouldProbeBehind(pullRequest({ mergeableState: 'blocked' }))).toBe(true);
    expect(shouldProbeBehind(pullRequest({ mergeableState: 'unstable' }))).toBe(true);
    expect(shouldProbeBehind(pullRequest({ mergeableState: 'clean' }))).toBe(false);
    expect(shouldProbeBehind(pullRequest({ mergeableState: 'dirty' }))).toBe(false);
    expect(shouldProbeBehind(pullRequest({ mergeableState: 'unknown' }))).toBe(false);
  });
});

describe('decideUpdate', () => {
  it('updates an eligible pull request that is behind', () => {
    expect(
      decideUpdate({ pullRequest: pullRequest(), filter, behind: true, method: 'merge' }),
    ).toEqual({ kind: 'update', method: 'merge' });
  });

  it('skips an eligible pull request that is not behind', () => {
    expect(
      decideUpdate({ pullRequest: pullRequest(), filter, behind: false, method: 'rebase' }),
    ).toEqual({ kind: 'skip', reason: 'not_behind' });
  });

  it('skips closed, merged, and deleted-fork pull requests', () => {
    expect(updateEligibility(pullRequest({ state: 'closed' }), filter)).toEqual('not_open');
    expect(updateEligibility(pullRequest({ merged: true }), filter)).toEqual('already_merged');
    expect(
      updateEligibility(
        pullRequest({ head: { ref: 'feature', sha: 'sha', repoFullName: null } }),
        filter,
      ),
    ).toEqual('head_repo_missing');
  });

  it('skips blocking and missing label cases', () => {
    expect(updateEligibility(pullRequest({ labels: ['automerge', 'wip'] }), filter)).toEqual(
      'blocking_label',
    );
    expect(updateEligibility(pullRequest({ labels: ['wip'] }), filter)).toEqual('blocking_label');
    expect(updateEligibility(pullRequest({ labels: [] }), filter)).toEqual(
      'required_label_missing',
    );
  });
});

describe('decideMerge', () => {
  it('returns the configured method and no commit title for automatic', () => {
    expect(
      decideMerge({
        pullRequest: pullRequest(),
        filter,
        method: 'squash',
        commitMessage: 'automatic',
      }),
    ).toEqual({ kind: 'ready', method: 'squash', commitTitle: undefined });
  });

  it('uses the pull request title when configured', () => {
    expect(
      decideMerge({
        pullRequest: pullRequest({ title: 'My change' }),
        filter,
        method: 'merge',
        commitMessage: 'pull-request-title',
      }),
    ).toEqual({ kind: 'ready', method: 'merge', commitTitle: 'My change' });
  });

  it.each(['blocked', 'behind', 'dirty', 'draft', 'other'] as const)(
    'is not ready for %s',
    (state) => {
      expect(
        decideMerge({
          pullRequest: pullRequest({ mergeableState: state }),
          filter,
          method: 'merge',
          commitMessage: 'automatic',
        }),
      ).toEqual({ kind: 'not_ready', reason: state });
    },
  );

  it('reports unknown when mergeability is still unknown', () => {
    expect(
      decideMerge({
        pullRequest: pullRequest({ mergeableState: null }),
        filter,
        method: 'merge',
        commitMessage: 'automatic',
      }),
    ).toEqual({ kind: 'not_ready', reason: 'unknown' });
  });

  it('skips closed, merged, deleted-fork, and label-filtered pull requests', () => {
    expect(
      decideMerge({
        pullRequest: pullRequest({ state: 'closed' }),
        filter,
        method: 'merge',
        commitMessage: 'automatic',
      }),
    ).toEqual({ kind: 'skip', reason: 'not_open' });
    expect(
      decideMerge({
        pullRequest: pullRequest({ merged: true }),
        filter,
        method: 'merge',
        commitMessage: 'automatic',
      }),
    ).toEqual({ kind: 'skip', reason: 'already_merged' });
    expect(
      decideMerge({
        pullRequest: pullRequest({ head: { ref: 'feature', sha: 'sha', repoFullName: null } }),
        filter,
        method: 'merge',
        commitMessage: 'automatic',
      }),
    ).toEqual({ kind: 'skip', reason: 'head_repo_missing' });
    expect(
      decideMerge({
        pullRequest: pullRequest({ labels: ['automerge', 'wip'] }),
        filter,
        method: 'merge',
        commitMessage: 'automatic',
      }),
    ).toEqual({ kind: 'skip', reason: 'blocking_label' });
    expect(
      decideMerge({
        pullRequest: pullRequest({ labels: [] }),
        filter,
        method: 'merge',
        commitMessage: 'automatic',
      }),
    ).toEqual({ kind: 'skip', reason: 'required_label_missing' });
  });
});

describe('commitTitleFor', () => {
  it('maps automatic and title modes', () => {
    expect(commitTitleFor('automatic', 'Title')).toBeUndefined();
    expect(commitTitleFor('pull-request-title', 'Title')).toEqual('Title');
  });
});

describe('mergeable state union', () => {
  it('covers every known state', () => {
    const states: readonly MergeableState[] = [
      'clean',
      'has_hooks',
      'unstable',
      'blocked',
      'behind',
      'dirty',
      'draft',
      'unknown',
      'other',
    ];

    expect(
      states.map((state) => classifyMergeableState(pullRequest({ mergeableState: state })).kind),
    ).toEqual([
      'ready',
      'ready',
      'ready',
      'not_ready',
      'not_ready',
      'not_ready',
      'not_ready',
      'unknown',
      'not_ready',
    ]);
  });
});
