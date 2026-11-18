import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGitRunner, type GitRunner } from '@/git/command';
import { fetchUntilMergeBase, rebaseOntoBase } from '@/git/rebase';
import { withTempDir } from '@/git/tmpdir';
import { err, ok } from '@/result';

import { expectOk, pullRequest } from './factories';
import { createFakeLogger } from './fakes';

const logger = createFakeLogger();
const git = createGitRunner(logger);

async function run(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git.run(cwd, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${JSON.stringify(result.error)}`);
  }
  return result.value.stdout;
}

async function init(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run(dir, ['init']);
  await run(dir, ['checkout', '-b', 'main']);
}

async function commit(dir: string, message = 'C%d', count = 1): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await run(dir, ['commit', '--allow-empty', '-m', message.replace(/%d/g, String(index))]);
  }
}

async function commitFile(dir: string, file: string, message: string): Promise<void> {
  await writeFile(join(dir, file), `${message}\n`);
  await run(dir, ['add', file]);
  await run(dir, ['commit', '-m', message]);
}

async function inTempDir<T>(runInDir: (path: string) => Promise<T>): Promise<T> {
  return expectOk(await withTempDir(async (path) => ok(await runInDir(path))));
}

describe('fetchUntilMergeBase', () => {
  it('finds the correct merge base', async () => {
    await inTempDir(async (path) => {
      const origin = join(path, 'origin');
      await init(origin);
      await commit(origin, 'base %d', 10);
      const base = await run(origin, ['rev-parse', 'HEAD']);
      await run(origin, ['checkout', '-b', 'br1']);
      await commit(origin, 'br1 %d', 20);
      await run(origin, ['checkout', 'main']);
      await commit(origin, 'main %d', 20);

      const workspace = join(path, 'ws');
      await run('.', ['clone', '--branch', 'br1', origin, workspace]);
      await run(workspace, ['fetch', 'origin', 'main:refs/remotes/origin/main']);

      const deps = { git, logger, now: Date.now, cloneUrl: (repoFullName: string) => repoFullName };
      expect(
        await fetchUntilMergeBase(deps, workspace, 'main', 'br1', Date.now() + 10_000),
      ).toEqual(ok(base));
    });
  }, 15_000);

  it('finds the earliest merge base across merge commits', async () => {
    await inTempDir(async (path) => {
      const origin = join(path, 'origin');
      await init(origin);
      await commit(origin, 'base %d', 10);
      const base = await run(origin, ['rev-parse', 'HEAD']);
      await run(origin, ['branch', 'br1']);
      await commit(origin, 'main %d', 10);
      await run(origin, ['checkout', 'br1']);
      await commit(origin, 'br1 before merge %d', 5);
      await run(origin, ['merge', '--no-ff', 'main']);
      await commit(origin, 'br1 after merge %d', 10);
      await run(origin, ['checkout', 'main']);
      await commit(origin, 'main after merge %d', 10);

      const workspace = join(path, 'ws');
      await run('.', ['clone', '--branch', 'br1', origin, workspace]);
      await run(workspace, ['fetch', 'origin', 'main:refs/remotes/origin/main']);

      const deps = { git, logger, now: Date.now, cloneUrl: (repoFullName: string) => repoFullName };
      expect(
        await fetchUntilMergeBase(deps, workspace, 'main', 'br1', Date.now() + 10_000),
      ).toEqual(ok(base));
    });
  }, 15_000);

  it('times out when no common base can be found', async () => {
    const deps = { git, logger, now: Date.now, cloneUrl: (repoFullName: string) => repoFullName };

    expect(await fetchUntilMergeBase(deps, '.', 'main', 'br1', 0)).toEqual({
      ok: false,
      error: { kind: 'timeout' },
    });
  });
});

describe('shallow merge-base discovery', () => {
  it('deepens both branches repeatedly until a deep merge base is present', async () => {
    await inTempDir(async (path) => {
      const origin = join(path, 'origin');
      await init(origin);
      await commit(origin, 'base %d', 40);
      const base = await run(origin, ['rev-parse', 'HEAD']);
      await run(origin, ['checkout', '-b', 'br1']);
      await commit(origin, 'br1 %d', 20);
      await run(origin, ['checkout', 'main']);
      await commit(origin, 'main %d', 20);

      const workspace = join(path, 'ws');
      await run('.', [
        'clone',
        '--quiet',
        '--depth',
        '2',
        '--branch',
        'br1',
        `file://${origin}`,
        workspace,
      ]);
      await run(workspace, [
        'fetch',
        '--quiet',
        '--depth',
        '2',
        'origin',
        'main:refs/remotes/origin/main',
      ]);

      expect(await run(workspace, ['rev-parse', '--is-shallow-repository'])).toEqual('true');

      const calls: string[][] = [];
      const recordingGit: GitRunner = {
        run: async (cwd, args, options) => {
          calls.push([...args]);
          return git.run(cwd, args, options);
        },
      };
      const deps = { git: recordingGit, logger, now: Date.now, cloneUrl: () => '' };

      expect(
        await fetchUntilMergeBase(deps, workspace, 'main', 'br1', Date.now() + 20_000),
      ).toEqual(ok(base));

      const deepens = calls.filter((args) => args[0] === 'fetch' && args.includes('--deepen'));
      expect(deepens.length).toBeGreaterThanOrEqual(2);
      expect(deepens.at(-1)).toEqual(
        expect.arrayContaining(['+refs/heads/br1:refs/remotes/origin/br1']),
      );
    });
  }, 30_000);

  it('resolves a criss-cross history to its earliest merge base', async () => {
    await inTempDir(async (path) => {
      const origin = join(path, 'origin');
      await init(origin);
      await commitFile(origin, 'base.txt', 'base');
      const base = await run(origin, ['rev-parse', 'HEAD']);

      await run(origin, ['checkout', '-b', 'br1']);
      await commitFile(origin, 'br1.txt', 'br1');

      await run(origin, ['checkout', 'main']);
      await commitFile(origin, 'main.txt', 'main');

      await run(origin, ['checkout', 'br1']);
      await run(origin, ['merge', '--no-ff', 'main', '-m', 'merge main into br1']);

      await run(origin, ['checkout', 'main']);
      await run(origin, ['merge', '--no-ff', 'br1~1', '-m', 'merge br1 into main']);

      expect((await run(origin, ['merge-base', '--all', 'br1', 'main'])).split('\n')).toHaveLength(
        2,
      );

      const workspace = join(path, 'ws');
      await run('.', ['clone', '--quiet', '--branch', 'br1', `file://${origin}`, workspace]);
      await run(workspace, ['fetch', '--quiet', 'origin', 'main:refs/remotes/origin/main']);

      const deps = { git, logger, now: Date.now, cloneUrl: () => '' };
      expect(
        await fetchUntilMergeBase(deps, workspace, 'main', 'br1', Date.now() + 20_000),
      ).toEqual(ok(base));
    });
  }, 20_000);

  it('reports no common ancestor for unrelated histories', async () => {
    await inTempDir(async (path) => {
      const origin = join(path, 'origin');
      await init(origin);
      await commit(origin, 'main %d', 10);
      await run(origin, ['checkout', '--orphan', 'unrelated']);
      await commit(origin, 'unrelated %d', 10);
      await run(origin, ['checkout', 'main']);

      const workspace = join(path, 'ws');
      await run('.', [
        'clone',
        '--quiet',
        '--depth',
        '2',
        '--branch',
        'main',
        `file://${origin}`,
        workspace,
      ]);
      await run(workspace, [
        'fetch',
        '--quiet',
        '--depth',
        '2',
        'origin',
        'unrelated:refs/remotes/origin/unrelated',
      ]);

      const deps = { git, logger, now: Date.now, cloneUrl: () => '' };
      expect(
        await fetchUntilMergeBase(deps, workspace, 'unrelated', 'main', Date.now() + 20_000),
      ).toEqual({ ok: false, error: { kind: 'no_common_ancestor' } });
    });
  }, 20_000);

  it('propagates a deepening fetch failure', async () => {
    await inTempDir(async (path) => {
      const origin = join(path, 'origin');
      await init(origin);
      await commit(origin, 'base %d', 10);
      await run(origin, ['checkout', '-b', 'base-branch']);
      await commit(origin, 'base-branch %d', 10);
      await run(origin, ['checkout', 'main']);
      await commit(origin, 'main %d', 10);

      const workspace = join(path, 'ws');
      await run('.', [
        'clone',
        '--quiet',
        '--depth',
        '2',
        '--branch',
        'main',
        `file://${origin}`,
        workspace,
      ]);
      await run(workspace, [
        'fetch',
        '--quiet',
        '--depth',
        '2',
        'origin',
        'base-branch:refs/remotes/origin/base-branch',
      ]);

      await rm(origin, { recursive: true, force: true });

      const deps = { git, logger, now: Date.now, cloneUrl: () => '' };
      const result = await fetchUntilMergeBase(
        deps,
        workspace,
        'base-branch',
        'main',
        Date.now() + 20_000,
      );

      expect(result).toMatchObject({ ok: false, error: { kind: 'unexpected_exit' } });
    });
  }, 20_000);
});

describe('rebaseOntoBase', () => {
  it('rebases the head branch onto the base and force-pushes it', async () => {
    await inTempDir(async (path) => {
      const origin = join(path, 'origin.git');
      await mkdir(origin, { recursive: true });
      await run(origin, ['init', '--bare']);

      const seed = join(path, 'seed');
      await run('.', ['clone', origin, seed]);
      await run(seed, ['checkout', '-b', 'main']);
      await commit(seed, 'base');
      await run(seed, ['push', '-u', 'origin', 'main']);

      await run(seed, ['checkout', '-b', 'feature']);
      await commit(seed, 'feature work');
      await run(seed, ['push', '-u', 'origin', 'feature']);
      const featureSha = await run(seed, ['rev-parse', 'HEAD']);

      await run(seed, ['checkout', 'main']);
      await commit(seed, 'main moved');
      await run(seed, ['push', 'origin', 'main']);

      const deps = { git, logger, now: Date.now, cloneUrl: () => origin };
      const result = await rebaseOntoBase(
        deps,
        pullRequest({
          head: { ref: 'feature', sha: featureSha, repoFullName: 'owner/repo' },
          base: { ref: 'main', sha: 'base-sha', repoFullName: 'owner/repo' },
        }),
      );

      const newSha = expectOk(result);
      expect(newSha).not.toBeNull();
      expect(newSha).not.toEqual(featureSha);
      expect(await run(origin, ['rev-parse', 'refs/heads/feature'])).toEqual(newSha);
    });
  }, 20_000);
});

describe('createGitRunner', () => {
  it('returns trimmed stdout and the exit code', async () => {
    const result = expectOk(await git.run('.', ['rev-parse', '--is-inside-work-tree']));

    expect(result).toEqual({ stdout: 'true', exitCode: 0 });
  });

  it('reports unexpected exit codes with bounded stderr', async () => {
    const result = await git.run('.', ['rev-parse', '--verify', 'refs/heads/does-not-exist']);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toMatchObject({
      kind: 'unexpected_exit',
      command: 'git rev-parse --verify refs/heads/does-not-exist',
      exitCode: 128,
    });
    expect(result.ok ? '' : result.error).toMatchObject({
      stderr: expect.stringContaining('fatal'),
    });
  });

  it('returns output for allowed non-zero exit codes', async () => {
    const result = expectOk(
      await git.run('.', ['rev-parse', '--verify', 'refs/heads/does-not-exist'], {
        allowedExitCodes: [128],
      }),
    );

    expect(result.exitCode).toEqual(128);
  });

  it('reports spawn failures', async () => {
    const missingDirectory = join(tmpdir(), 'automerge-missing-directory');
    const result = await git.run(missingDirectory, ['status']);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'spawn_failed', command: 'git status' },
    });
    expect(result.ok ? '' : result.error).toMatchObject({
      message: expect.stringContaining('ENOENT'),
    });
  });

  it('terminates the whole process tree when a command times out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'automerge-timeout-'));
    const pidFile = join(dir, 'pid');
    const started = Date.now();

    try {
      const result = await git.run(
        dir,
        ['-c', `alias.wait=!sh -c 'echo $$ > ${pidFile}; sleep 5'`, 'wait'],
        { timeoutMs: 1000 },
      );

      expect(Date.now() - started).toBeLessThan(3000);
      expect(result).toMatchObject({ ok: false, error: { kind: 'timed_out', timeoutMs: 1000 } });

      await new Promise((resolve) => setTimeout(resolve, 300));
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow('ESRCH');

      expectOk(await git.run(dir, ['--version']));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fetchUntilMergeBase deadlines', () => {
  it('passes the remaining deadline to git commands', async () => {
    const calls: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
    let clock = 0;
    const fakeGit: GitRunner = {
      run: async (_cwd, args, options) => {
        calls.push({ args, timeoutMs: options?.timeoutMs });
        if (args[0] === 'merge-base') {
          clock = 400;
          return ok({ stdout: '', exitCode: 1 });
        }
        if (args[0] === 'rev-parse') {
          clock = 500;
          return ok({ stdout: 'true', exitCode: 0 });
        }
        clock = 1100;
        return ok({ stdout: '', exitCode: 0 });
      },
    };
    const deps = { git: fakeGit, logger, now: () => clock, cloneUrl: () => '' };

    const result = await fetchUntilMergeBase(deps, '.', 'main', 'br1', 1000);

    expect(result).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(calls.map((call) => call.args[0])).toEqual(['merge-base', 'rev-parse', 'fetch']);
    expect(calls.map((call) => call.timeoutMs)).toEqual([1000, 600, 500]);
  });

  it('reports no common ancestor when a complete repository has none', async () => {
    const fakeGit: GitRunner = {
      run: async (_cwd, args) => {
        if (args[0] === 'merge-base') return ok({ stdout: '', exitCode: 1 });
        if (args[0] === 'rev-parse') return ok({ stdout: 'false', exitCode: 0 });
        throw new Error(`unexpected git command: ${args.join(' ')}`);
      },
    };
    const deps = { git: fakeGit, logger, now: () => 0, cloneUrl: () => '' };

    expect(await fetchUntilMergeBase(deps, '.', 'main', 'br1', 1000)).toEqual({
      ok: false,
      error: { kind: 'no_common_ancestor' },
    });
  });

  it('maps a timed-out git subprocess to a timeout error', async () => {
    const fakeGit: GitRunner = {
      run: async () => err({ kind: 'timed_out', command: 'git merge-base', timeoutMs: 10 }),
    };
    const deps = { git: fakeGit, logger, now: () => 0, cloneUrl: () => '' };

    expect(await fetchUntilMergeBase(deps, '.', 'main', 'br1', 1000)).toEqual({
      ok: false,
      error: { kind: 'timeout' },
    });
  });
});
