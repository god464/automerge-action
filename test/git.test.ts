import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitRunner } from '../src/git/command';
import { fetchUntilMergeBase, rebaseOntoBase } from '../src/git/rebase';
import { withTempDir } from '../src/git/tmpdir';
import { ok } from '../src/result';
import { createFakeLogger } from './fakes';
import { expectOk, pullRequest } from './factories';

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
      expect(await fetchUntilMergeBase(deps, workspace, 'main', 10_000)).toEqual(ok(base));
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
      expect(await fetchUntilMergeBase(deps, workspace, 'main', 10_000)).toEqual(ok(base));
    });
  }, 15_000);

  it('times out when no common base can be found', async () => {
    const deps = { git, logger, now: Date.now, cloneUrl: (repoFullName: string) => repoFullName };

    expect(await fetchUntilMergeBase(deps, '.', 'main', 0)).toEqual({
      ok: false,
      error: { kind: 'timeout' },
    });
  });
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
