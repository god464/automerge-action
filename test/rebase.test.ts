import { describe, expect, it } from 'vitest';

import type { GitError, GitOutput, GitRunner } from '@/git/command';
import { REBASE_TIMEOUT_MS, rebaseOntoBase } from '@/git/rebase';
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
const timedOut: Reply = err({ kind: 'timed_out', command: 'git', timeoutMs: 1 });

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
  readonly shallow?: Reply;
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
      if (args[0] === 'rev-parse') return script.shallow ?? success('true');
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

  it.each([
    ['clone', { clone: timedOut }],
    ['initial fetch', { fetch: timedOut }],
    ['merge base lookup', { mergeBase: () => timedOut }],
    ['rebase', { rebase: timedOut }],
    ['push', { push: timedOut, newHead: success('new-sha') }],
  ] as const)('maps a timed-out %s subprocess to a timeout error', async (_label, script) => {
    expect(await rebaseOntoBase(deps(scriptedGit(script).git), rebaseHead())).toEqual({
      ok: false,
      error: { kind: 'timeout' },
    });
  });

  it('uses one shrinking budget for every git command', async () => {
    const calls: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
    let clock = 0;
    let heads = 0;
    const git: GitRunner = {
      run: async (_cwd, args, options) => {
        calls.push({ args, timeoutMs: options?.timeoutMs });
        clock += 1000;
        if (args[0] === 'merge-base') return success('base-sha');
        if (args[0] === 'show-ref') {
          if (!args.includes('/HEAD')) return success('onto-sha');
          heads += 1;
          return success(heads === 1 ? 'head-sha' : 'new-sha');
        }
        return success();
      },
    };

    expect(
      await rebaseOntoBase(
        { git, logger: createFakeLogger(), now: () => clock, cloneUrl: () => 'clone-url' },
        rebaseHead(),
      ),
    ).toEqual(ok('new-sha'));

    expect(calls.map((call) => call.args[0])).toEqual([
      'clone',
      'fetch',
      'merge-base',
      'rev-list',
      'show-ref',
      'show-ref',
      'rebase',
      'show-ref',
      'push',
    ]);
    expect(calls.map((call) => call.timeoutMs)).toEqual([
      REBASE_TIMEOUT_MS,
      REBASE_TIMEOUT_MS - 1000,
      REBASE_TIMEOUT_MS - 2000,
      REBASE_TIMEOUT_MS - 3000,
      REBASE_TIMEOUT_MS - 4000,
      REBASE_TIMEOUT_MS - 5000,
      REBASE_TIMEOUT_MS - 6000,
      REBASE_TIMEOUT_MS - 7000,
      REBASE_TIMEOUT_MS - 8000,
    ]);
  });

  it('does not start a new git command once the deadline is exhausted', async () => {
    const calls: string[] = [];
    let clock = 0;
    const git: GitRunner = {
      run: async (_cwd, args) => {
        calls.push(args[0] ?? '');
        clock = REBASE_TIMEOUT_MS + 1;
        return success();
      },
    };

    expect(
      await rebaseOntoBase(
        { git, logger: createFakeLogger(), now: () => clock, cloneUrl: () => 'clone-url' },
        rebaseHead(),
      ),
    ).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(calls).toEqual(['clone']);
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
        if (args.includes('--deepen')) clock.value = REBASE_TIMEOUT_MS + 1;
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

  it('reports no common ancestor once the repository is complete', async () => {
    const { git, calls } = scriptedGit({
      mergeBase: () => ok({ stdout: '', exitCode: 1 }),
      shallow: success('false'),
    });
    let clock = 0;

    expect(
      await rebaseOntoBase(
        {
          git,
          logger: createFakeLogger(),
          now: () => {
            clock += 1000;
            return clock;
          },
          cloneUrl: () => 'clone-url',
        },
        rebaseHead(),
      ),
    ).toEqual({ ok: false, error: { kind: 'no_common_ancestor' } });
    expect(calls.map((call) => call.args[0])).toEqual([
      'clone',
      'fetch',
      'merge-base',
      'rev-parse',
    ]);
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
        clock.value = REBASE_TIMEOUT_MS + 1;
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
