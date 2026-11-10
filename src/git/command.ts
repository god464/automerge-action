import { getExecOutput } from '@actions/exec';
import type { Logger } from '../actions/logger';
import { err, ok, type Result } from '../result';

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
  | { readonly kind: 'spawn_failed'; readonly command: string; readonly message: string };

export interface GitRunOptions {
  readonly allowedExitCodes?: readonly number[];
  readonly redactedCommand?: string;
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

export function createGitRunner(logger: Logger): GitRunner {
  return {
    run: async (cwd, args, options = {}) => {
      const command = options.redactedCommand ?? `git ${args.join(' ')}`;
      const allowedExitCodes = options.allowedExitCodes ?? [0];
      logger.debug(`Executing ${command}`);

      try {
        const output = await getExecOutput('git', [...GIT_IDENTITY_ARGS, ...args], {
          cwd,
          silent: true,
          ignoreReturnCode: true,
        });

        if (!allowedExitCodes.includes(output.exitCode)) {
          return err({
            kind: 'unexpected_exit',
            command,
            exitCode: output.exitCode,
            stderr: output.stderr.slice(0, 2000),
          });
        }

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
