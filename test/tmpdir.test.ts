import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '../src/git/tmpdir';
import { err, ok } from '../src/result';
import { expectOk } from './factories';

describe('withTempDir', () => {
  it('creates a directory and removes it after success', async () => {
    let created = '';

    const result = expectOk(
      await withTempDir(async (dir) => {
        created = dir;
        await writeFile(join(dir, 'file.txt'), 'content');
        return ok('value');
      }),
    );

    expect(result).toEqual('value');
    await expect(access(created)).rejects.toThrow('ENOENT');
  });

  it('removes the directory when the operation fails', async () => {
    let created = '';

    const result = await withTempDir(async (dir) => {
      created = dir;
      return err('failed');
    });

    expect(result).toEqual({ ok: false, error: 'failed' });
    await expect(access(created)).rejects.toThrow('ENOENT');
  });

  it('reports a creation failure when RUNNER_TEMP is not a directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'automerge-runner-'));
    const notADirectory = join(parent, 'file');
    await writeFile(notADirectory, 'content');
    const previous = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = notADirectory;

    try {
      expect(await withTempDir(async () => ok(true))).toMatchObject({
        ok: false,
        error: { kind: 'temp_dir_failed' },
      });
    } finally {
      if (previous == null) {
        delete process.env.RUNNER_TEMP;
      } else {
        process.env.RUNNER_TEMP = previous;
      }
    }
  });
});
