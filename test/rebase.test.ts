import { describe, expect, it } from 'vitest';

import type { GitError, GitOutput, GitRunner } from '@/git/command';
import { rebaseOntoBase } from '@/git/rebase';
import { err, ok, type Result } from '@/result';
import { pullRequest } from './factories';
import { createFakeLogger } from './fakes';

type Reply = Result<GitOutput, GitError>;

const success = (stdout = ''): Reply => ok({ stdout, exitCode: 0 });
const conflict: Reply = err({
  kind: 'unexpected_exit',
  command: 'git',
  exitCode: 1,
  stderr: 'failed',
});

interface Script {
  readonly clone?: Reply;
  readonly fetch?: Reply | ((args: readonly string[]) => Reply);
  readonly mergeBase?: (args: readonly string[]) => Reply;
  readonly head?: Reply;
  readonly onto?: Reply;
  readonly rebase?: Reply;
  readonly newHead?: Reply;
  readonly push?: Reply;
  readonly revList?: Reply;
}

function scriptedGit(script: Script) {
  const calls: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
  let headLookups = 0;
  const git: GitRunner = {
    run: async (_cwd, args, options) => {
      calls.push({ args, timeoutMs: options?.timeoutMs });
      if (args[0] === 'clone') return script.clone ?? success();
      if (args[0] === 'fetch')
        return typeof script.fetch === 'function'
          ? script.fetch(args)
          : (script.fetch ?? success());
      if (args[0] === 'merge-base') return script.mergeBase?.(args) ?? success('base-sha');
      if (args[0] === 'rev-list') return script.revList ?? success();
      if (args[0] === 'show-ref') {
        if (!args.includes('/HEAD')) return script.onto ?? success('onto-sha');
        headLookups += 1;
        return headLookups === 1
          ? (script.head ?? success('head-sha'))
          : (script.newHead ?? success('head-sha'));
      }
      if (args[0] === 'rebase') return script.rebase ?? success();
      if (args[0] === 'push') return script.push ?? success();
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    },
  };

  return { git, calls };
}

function deps(git: GitRunner, now: () => number = () => 0) {
  return { git, logger: createFakeLogger(), now, cloneUrl: () => 'clone-url' };
}

function rebaseHead() {
  return pullRequest({ head: { ref: 'feature', sha: 'head-sha', repoFullName: 'owner/repo' } });
}

describe('rebaseOntoBase failures', () => {
  it('rejects pull requests from a deleted fork before running git', async () => {
    const { git, calls } = scriptedGit({});

    expect(
      await rebaseOntoBase(
        deps(git),
        pullRequest({ head: { ref: 'feature', sha: 'head-sha', repoFullName: null } }),
      ),
    ).toEqual({ ok: false, error: { kind: 'head_repo_missing' } });
    expect(calls).toEqual([]);
  });

  it.each([
    ['clone', { clone: conflict }, conflict],
    ['fetch', { fetch: conflict }, conflict],
    ['merge base', { mergeBase: () => conflict }, conflict],
    ['head lookup', { head: conflict }, conflict],
    ['base lookup', { onto: conflict }, conflict],
    ['rebase', { rebase: conflict }, conflict],
    ['new head lookup', { newHead: conflict }, conflict],
    ['push', { push: conflict, newHead: success('new-sha') }, conflict],
  ] as const)('propagates %s failures', async (_label, script, expected) => {
    expect(await rebaseOntoBase(deps(scriptedGit(script).git), rebaseHead())).toEqual(expected);
  });

  it('refuses to push when the head branch moved', async () => {
    const { git } = scriptedGit({ head: success('someone-else') });

    expect(await rebaseOntoBase(deps(git), rebaseHead())).toEqual({
      ok: false,
      error: { kind: 'head_changed', expected: 'head-sha', actual: 'someone-else' },
    });
  });

  it('reports no update when the rebase is a no-op', async () => {
    const { git } = scriptedGit({ head: success('head-sha'), newHead: success('head-sha') });

    expect(await rebaseOntoBase(deps(git), rebaseHead())).toEqual(ok(null));
  });

  it('clones the head branch with bounded depth and no tags', async () => {
    const { git, calls } = scriptedGit({ head: success('head-sha'), newHead: success('head-sha') });

    await rebaseOntoBase(deps(git), rebaseHead());

    const clone = calls.find((call) => call.args[0] === 'clone')?.args ?? [];
    expect(clone).toContain('--no-tags');
    expect(clone).not.toContain('--shallow-submodules');
    expect(clone).toEqual(
      expect.arrayContaining(['--branch', 'feature', '--depth', '10', 'clone-url']),
    );
  });

  it('pushes the rebased head and returns the new SHA', async () => {
    const { git, calls } = scriptedGit({ head: success('head-sha'), newHead: success('new-sha') });

    expect(await rebaseOntoBase(deps(git), rebaseHead())).toEqual(ok('new-sha'));
    expect(calls.find((call) => call.args[0] === 'push')?.args).toEqual([
      'push',
      '--quiet',
      '--force-with-lease',
      'origin',
      'feature',
    ]);
  });
});

describe('findEarliestBase failures', () => {
  it('propagates rev-list failures', async () => {
    const { git } = scriptedGit({ mergeBase: () => success('base-sha'), revList: conflict });

    expect(await rebaseOntoBase(deps(git), rebaseHead())).toEqual(conflict);
  });

  it('propagates parent merge-base failures', async () => {
    const { git } = scriptedGit({
      mergeBase: (args) => (args[1] === 'HEAD' ? success('base-sha') : conflict),
      revList: success('commit parent-a parent-b'),
    });

    expect(await rebaseOntoBase(deps(git), rebaseHead())).toEqual(conflict);
  });

  it('reports no base when a merge parent has no common ancestor', async () => {
    const clock = { value: 0 };
    const { git } = scriptedGit({
      mergeBase: (args) =>
        args[1] === 'HEAD' ? success('base-sha') : ok({ stdout: '', exitCode: 1 }),
      revList: success('commit parent-a parent-b'),
      fetch: (args) => {
        if (args.includes('--deepen')) clock.value = 70_000;
        return success();
      },
    });

    expect(
      await rebaseOntoBase(
        deps(git, () => clock.value),
        rebaseHead(),
      ),
    ).toEqual({ ok: false, error: { kind: 'timeout' } });
  });

  it('propagates deepening fetch failures', async () => {
    const { git } = scriptedGit({
      mergeBase: () => ok({ stdout: '', exitCode: 1 }),
      fetch: (args) => (args.includes('--deepen') ? conflict : success()),
    });

    expect(await rebaseOntoBase(deps(git), rebaseHead())).toEqual(conflict);
  });

  it('stops when the deadline expires between git commands', async () => {
    const clock = { value: 0 };
    const { git } = scriptedGit({
      mergeBase: () => {
        clock.value = 70_000;
        return ok({ stdout: '', exitCode: 1 });
      },
    });

    expect(
      await rebaseOntoBase(
        deps(git, () => clock.value),
        rebaseHead(),
      ),
    ).toEqual({ ok: false, error: { kind: 'timeout' } });
  });
});
