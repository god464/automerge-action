import { type ChildProcess, spawn } from 'node:child_process';

import type { Logger } from '@/actions/logger';
import { err, ok, type Result } from '@/result';

export interface GitOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

export type GitError =
  | {
      readonly kind: 'unexpected_exit';
      readonly command: string;
      readonly exitCode: number;
      readonly stderr: string;
    }
  | { readonly kind: 'spawn_failed'; readonly command: string; readonly message: string }
  | { readonly kind: 'timed_out'; readonly command: string; readonly timeoutMs: number };

export interface GitRunOptions {
  readonly allowedExitCodes?: readonly number[];
  readonly redactedCommand?: string;
  readonly timeoutMs?: number;
}

export interface GitRunner {
  readonly run: (
    cwd: string,
    args: readonly string[],
    options?: GitRunOptions,
  ) => Promise<Result<GitOutput, GitError>>;
}

const GIT_IDENTITY_ARGS = [
  '-c',
  'user.name=GitHub',
  '-c',
  'user.email=noreply@github.com',
] as const;

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function terminate(child: ChildProcess): void {
  if (child.pid == null) return;

  try {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

async function execute(
  args: readonly string[],
  cwd: string,
  timeoutMs: number | undefined,
): Promise<ProcessResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>();
  let settled = false;
  let timedOut = false;
  let stdout = '';
  let stderr = '';

  const child = spawn('git', [...GIT_IDENTITY_ARGS, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const timer =
    timeoutMs == null
      ? undefined
      : setTimeout(() => {
          if (child.exitCode != null || child.signalCode != null) return;
          timedOut = true;
          terminate(child);
        }, timeoutMs);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });

  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
  });

  return promise;
}

export function createGitRunner(logger: Logger): GitRunner {
  return {
    run: async (cwd, args, options = {}) => {
      const command = options.redactedCommand ?? `git ${args.join(' ')}`;
      const allowedExitCodes = options.allowedExitCodes ?? [0];
      logger.debug(`Executing ${command}`);

      try {
        const output = await execute(args, cwd, options.timeoutMs);

        if (output.timedOut)
          return err({ kind: 'timed_out', command, timeoutMs: options.timeoutMs ?? 0 });

        if (!allowedExitCodes.includes(output.exitCode))
          return err({
            kind: 'unexpected_exit',
            command,
            exitCode: output.exitCode,
            stderr: output.stderr.slice(0, 2000),
          });

        return ok({ stdout: output.stdout.trim(), exitCode: output.exitCode });
      } catch (error) {
        return err({
          kind: 'spawn_failed',
          command,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
