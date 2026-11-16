import { describe, expect, it } from 'vitest';

import { parseConfig } from '@/config/config';
import { matchesLabelFilter, parseLabelFilter } from '@/domain/labels';
import { assertNever } from '@/result';
import { expectOk } from './factories';

describe('parseConfig', () => {
  it('uses the documented defaults', () => {
    const config = expectOk(parseConfig({ 'github-token': 'token' }));

    expect(config).toEqual({
      githubToken: 'token',
      mergeLabels: { required: ['automerge'], blocking: [] },
      mergeMethod: 'merge',
      mergeCommitMessage: 'automatic',
      updateLabels: { required: ['automerge'], blocking: [] },
      updateMethod: 'merge',
      labelConflicts: [],
    });
  });

  it('treats empty label inputs as no filter', () => {
    const config = expectOk(
      parseConfig({ 'github-token': 'token', 'merge-labels': '', 'update-labels': '' }),
    );

    expect(config.mergeLabels).toEqual({ required: [], blocking: [] });
    expect(config.updateLabels).toEqual({ required: [], blocking: [] });
  });

  it('parses required, blocking, whitespace, and duplicate labels', () => {
    const config = expectOk(
      parseConfig({
        'github-token': 'token',
        'merge-labels': ' automerge, !wip, ! wip, automerge ',
        'update-labels': 'automerge',
      }),
    );

    expect(config.mergeLabels).toEqual({ required: ['automerge'], blocking: ['wip'] });
  });

  it('lets blocking labels win and reports conflicts', () => {
    const config = expectOk(
      parseConfig({ 'github-token': 'token', 'merge-labels': 'automerge,!automerge' }),
    );

    expect(config.mergeLabels).toEqual({ required: [], blocking: ['automerge'] });
    expect(config.labelConflicts).toEqual([{ input: 'merge-labels', label: 'automerge' }]);
  });

  it('normalizes enum inputs case-insensitively', () => {
    const config = expectOk(
      parseConfig({
        'github-token': ' token ',
        'merge-method': ' SQUASH ',
        'merge-commit-message': 'Pull-Request-Title',
        'update-method': ' REBASE ',
      }),
    );

    expect(config.githubToken).toEqual('token');
    expect(config.mergeMethod).toEqual('squash');
    expect(config.mergeCommitMessage).toEqual('pull-request-title');
    expect(config.updateMethod).toEqual('rebase');
  });

  it('rejects a missing token', () => {
    expect(parseConfig({ 'github-token': '   ' })).toEqual({
      ok: false,
      error: [{ kind: 'missing_input', input: 'github-token' }],
    });
  });

  it.each([
    ['merge-method', 'fast-forward', ['merge', 'squash', 'rebase']],
    ['merge-commit-message', 'manual', ['automatic', 'pull-request-title']],
    ['update-method', 'squash', ['merge', 'rebase']],
  ] as const)('rejects invalid %s values', (input, value, allowed) => {
    expect(parseConfig({ 'github-token': 'token', [input]: value })).toEqual({
      ok: false,
      error: [{ kind: 'invalid_enum', input, value, allowed }],
    });
  });

  it('reports conflicts for both label inputs', () => {
    const config = expectOk(
      parseConfig({
        'github-token': 'token',
        'merge-labels': 'automerge,!automerge',
        'update-labels': 'ready,!ready',
      }),
    );

    expect(config.labelConflicts).toEqual([
      { input: 'merge-labels', label: 'automerge' },
      { input: 'update-labels', label: 'ready' },
    ]);
  });
});

describe('labels', () => {
  it('matches empty filters', () => {
    expect(matchesLabelFilter([], { required: [], blocking: [] })).toBe(true);
  });

  it('requires every required label and no blocking label', () => {
    const filter = { required: ['automerge', 'ready'], blocking: ['wip'] };

    expect(matchesLabelFilter(['automerge', 'ready'], filter)).toBe(true);
    expect(matchesLabelFilter(['automerge'], filter)).toBe(false);
    expect(matchesLabelFilter(['automerge', 'ready', 'wip'], filter)).toBe(false);
  });

  it('ignores a lone exclamation mark', () => {
    const parsed = parseLabelFilter('automerge,!,', 'automerge');

    expect(parsed.filter).toEqual({ required: ['automerge'], blocking: [] });
  });
});

describe('assertNever', () => {
  it('throws for values outside the exhaustive union', () => {
    expect(() => assertNever('unexpected' as never)).toThrow('Unexpected value: unexpected');
  });
});
