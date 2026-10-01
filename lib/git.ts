import { spawn } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';

import { TimeoutError, logger } from './common';

export class ExitError extends Error {
  code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

const FETCH_DEPTH = '10';

const COMMON_ARGS = ['-c', 'user.name=GitHub', '-c', 'user.email=noreply@github.com'];

export function git(cwd: string, ...args: Array<string | null>): Promise<string> {
  const stdio: StdioOptions = [
    'ignore',
    'pipe',
    logger.level === 'trace' || logger.level === 'debug' ? 'inherit' : 'ignore',
  ];
  // the URL passed to the clone command could contain a password!
  const command = args.includes('clone') ? 'git clone' : `git ${args.join(' ')}`;
  logger.debug('Executing', command);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const proc = spawn('git', COMMON_ARGS.concat(args.filter((a): a is string => a !== null)), {
    cwd,
    stdio,
  });
  const buffers: Buffer[] = [];
  proc.stdout?.on('data', (data: Buffer) => buffers.push(data));
  proc.on('error', () => {
    reject(new Error(`command failed: ${command}`));
  });
  proc.on('exit', (code) => {
    if (code === 0) {
      const data = Buffer.concat(buffers);
      resolve(data.toString('utf8').trim());
    } else {
      reject(new ExitError(`command failed with code ${code}: ${command}`, code));
    }
  });
  return promise;
}

export async function clone(from: string, to: string, branch: string): Promise<void> {
  await git(
    '.',
    'clone',
    '--quiet',
    '--shallow-submodules',
    '--branch',
    branch,
    '--depth',
    FETCH_DEPTH,
    from,
    to,
  );
}

export async function fetch(dir: string, branch: string): Promise<void> {
  await git(
    dir,
    'fetch',
    '--quiet',
    '--depth',
    FETCH_DEPTH,
    'origin',
    `${branch}:refs/remotes/origin/${branch}`,
  );
}

export async function fetchUntilMergeBase(
  dir: string,
  branch: string,
  timeout: number,
): Promise<string> {
  const maxTime = new Date().getTime() + timeout;
  const ref = `refs/remotes/origin/${branch}`;
  while (new Date().getTime() < maxTime) {
    const base = await mergeBase(dir, 'HEAD', ref);
    if (base) {
      const bases = [base];
      const parents = await mergeCommits(dir, ref);
      let fetchMore = false;
      for (const parent of parents.flat()) {
        const b = await mergeBase(dir, parent, ref);
        if (b) {
          if (!bases.includes(b)) {
            bases.push(b);
          }
        } else {
          // we found a commit which does not have a common ancestor with
          // the branch we want to merge, so we need to fetch more
          fetchMore = true;
          break;
        }
      }
      if (!fetchMore) {
        const commonBase = await mergeBase(dir, ...bases);
        if (!commonBase) {
          throw new Error(`failed to find common base for ${bases.join(',')}`);
        }
        return commonBase;
      }
    }
    await fetchDeepen(dir);
  }
  throw new TimeoutError();
}

export async function fetchDeepen(dir: string): Promise<void> {
  await git(dir, 'fetch', '--quiet', '--deepen', FETCH_DEPTH);
}

export async function mergeBase(dir: string, ...refs: string[]): Promise<string | null> {
  if (refs.length === 1) {
    return refs[0];
  } else if (refs.length < 1) {
    throw new Error('empty refs!');
  }
  let todo = refs;
  try {
    while (todo.length > 1) {
      const base = await git(dir, 'merge-base', todo[0], todo[1]);
      todo = [base].concat(todo.slice(2));
    }
    return todo[0];
  } catch (e) {
    if (e instanceof ExitError && e.code === 1) {
      return null;
    } else {
      throw e;
    }
  }
}

export async function mergeCommits(dir: string, ref: string): Promise<string[][]> {
  return (await git(dir, 'rev-list', '--parents', `${ref}..HEAD`))
    .split(/\n/g)
    .map((line) => line.split(/ /g).slice(1))
    .filter((commit) => commit.length > 1);
}

export async function head(dir: string): Promise<string> {
  return await git(dir, 'show-ref', '--head', '-s', '/HEAD');
}

export async function sha(dir: string, branch: string): Promise<string> {
  return await git(dir, 'show-ref', '-s', `refs/remotes/origin/${branch}`);
}

export async function rebase(dir: string, branch: string): Promise<string> {
  return await git(dir, 'rebase', '--quiet', '--autosquash', branch);
}

export async function push(dir: string, force: boolean, branch: string): Promise<string> {
  return await git(dir, 'push', '--quiet', force ? '--force-with-lease' : null, 'origin', branch);
}
