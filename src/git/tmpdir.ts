import { mkdtemp } from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRF } from '@actions/io';

import { err, ok, type Result } from '@/result';

export type TempDirError = { readonly kind: 'temp_dir_failed'; readonly message: string };

async function createTempDir(): Promise<Result<string, TempDirError>> {
  try {
    return ok(await mkdtemp(join(process.env.RUNNER_TEMP ?? osTmpdir(), 'automerge-')));
  } catch (error) {
    return err({
      kind: 'temp_dir_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function withTempDir<T, E>(
  run: (path: string) => Promise<Result<T, E>>,
): Promise<Result<T, E | TempDirError>> {
  const created = await createTempDir();
  if (!created.ok) return created;

  try {
    return await run(created.value);
  } finally {
    await rmRF(created.value).catch(() => undefined);
  }
}
