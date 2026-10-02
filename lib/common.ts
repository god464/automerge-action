import util from 'node:util';
import process from 'node:process';

import fse from 'fs-extra';
import tmp from 'tmp';

import type {
  Config,
  ConfigEnv,
  LabelFilter,
  MergeMethodLabel,
  PullRequestInput,
} from './types.js';

export const RESULT_SKIPPED = 'skipped';
export const RESULT_NOT_READY = 'not_ready';
export const RESULT_AUTHOR_FILTERED = 'author_filtered';
export const RESULT_MERGE_FAILED = 'merge_failed';
export const RESULT_MERGED = 'merged';

export class ClientError extends Error {}

export class TimeoutError extends Error {}

export type LogLevel = 'info' | 'debug' | 'trace';

export interface Logger {
  level: LogLevel;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function log(prefix: string | null, obj: unknown[]): void {
  if (process.env.NODE_ENV !== 'test') {
    const now = new Date().toISOString();
    const str = obj.map((o) => (typeof o === 'object' ? util.inspect(o, false, null, true) : o));
    if (prefix) {
      console.log(now, prefix, ...str);
    } else {
      console.log(now, ...str);
    }
  }
}

export const logger: Logger = {
  level: 'info',

  trace: (...str) => {
    if (logger.level === 'trace') {
      log('TRACE', str);
    }
  },

  debug: (...str) => {
    if (logger.level === 'trace' || logger.level === 'debug') {
      log('DEBUG', str);
    }
  },

  info: (...str) => log('INFO ', str),

  error: (...str) => {
    if (str.length === 1 && str[0] instanceof Error) {
      if (logger.level === 'trace' || logger.level === 'debug') {
        log(null, [str[0].stack || str[0]]);
      } else {
        log('ERROR', [str[0].message || str[0]]);
      }
    } else {
      log('ERROR', str);
    }
  },
};

export function createConfig(env: ConfigEnv = {}): Config {
  function parseMergeLabels(str: string | number | undefined, defaultValue: string): LabelFilter {
    const arr = (str == null ? defaultValue : String(str)).split(',').map((s) => s.trim());
    return {
      required: arr.filter((s) => !s.startsWith('!') && s.length > 0),
      blocking: arr
        .filter((s) => s.startsWith('!'))
        .map((s) => s.slice(1).trim())
        .filter((s) => s.length > 0),
    };
  }

  function parseLabelMethods(str: string | number | undefined): MergeMethodLabel[] {
    return (str ? String(str).split(',') : []).map((lm) => {
      const [label, method] = lm.split('=');
      if (!label || !method) {
        throw new Error(`Couldn't parse "${lm}" as "<label>=<method>" expression`);
      }
      return { label, method };
    });
  }

  function parseArray(str: string | number | undefined, defaultArray: string[] = []): string[] {
    return str ? String(str).split(',') : defaultArray;
  }

  function parseBranches(str: string | number | undefined, defaultValue: string): string[] {
    return (str == null ? defaultValue : String(str))
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function parsePositiveInt(name: string, defaultValue: number): number {
    const val = env[name];
    if (val == null || val === '') {
      return defaultValue;
    }

    const number = parseInt(String(val), 10);
    if (isNaN(number) || number < 0) {
      throw new ClientError(`Not a positive integer: ${val}`);
    }
    return number;
  }

  function parsePullRequest(pullRequest: string | number | undefined): PullRequestInput | null {
    if (!pullRequest) {
      return null;
    }

    logger.info(`Parsing PULL_REQUEST input: ${pullRequest}`);

    const error = new ClientError(
      `Invalid value provided for input PULL_REQUEST: ${pullRequest}. Must be a positive integer, optionally prefixed by a repo slug.`,
    );

    if (typeof pullRequest === 'string') {
      let repoOwner: string | undefined;
      let repoName: string | undefined;
      let pullRequestNumber: number | string | undefined;

      const destructuredPullRequest = pullRequest.split('/');
      if (destructuredPullRequest.length === 3) {
        [repoOwner, repoName, pullRequestNumber] = destructuredPullRequest;
      } else if (destructuredPullRequest.length === 1) {
        [pullRequestNumber] = destructuredPullRequest;
      } else {
        throw error;
      }

      const number = parseInt(String(pullRequestNumber), 10);
      if (isNaN(number) || number <= 0) {
        throw error;
      }

      return { repoOwner, repoName, pullRequestNumber: number };
    }

    if (typeof pullRequest === 'number' && pullRequest > 0) {
      return { pullRequestNumber: pullRequest };
    }

    throw error;
  }

  const mergeLabels = parseMergeLabels(env.MERGE_LABELS, 'automerge');
  const mergeRemoveLabels = parseArray(env.MERGE_REMOVE_LABELS);
  const mergeMethod = env.MERGE_METHOD ? String(env.MERGE_METHOD) : 'merge';
  const mergeForks = env.MERGE_FORKS !== 'false';
  const mergeCommitMessage = env.MERGE_COMMIT_MESSAGE
    ? String(env.MERGE_COMMIT_MESSAGE)
    : 'automatic';
  const mergeCommitMessageRegex = env.MERGE_COMMIT_MESSAGE_REGEX
    ? String(env.MERGE_COMMIT_MESSAGE_REGEX)
    : '';
  const mergeFilterAuthor = env.MERGE_FILTER_AUTHOR ? String(env.MERGE_FILTER_AUTHOR) : '';
  const mergeRetries = parsePositiveInt('MERGE_RETRIES', 6);
  const mergeRetrySleep = parsePositiveInt('MERGE_RETRY_SLEEP', 5000);
  const mergeRequiredApprovals = parsePositiveInt('MERGE_REQUIRED_APPROVALS', 0);
  const mergeDeleteBranch = env.MERGE_DELETE_BRANCH === 'true';
  const mergeDeleteBranchFilter = parseArray(env.MERGE_DELETE_BRANCH_FILTER);
  const mergeMethodLabels = parseLabelMethods(env.MERGE_METHOD_LABELS);
  const mergeMethodLabelRequired = env.MERGE_METHOD_LABEL_REQUIRED === 'true';
  const mergeErrorFail = env.MERGE_ERROR_FAIL === 'true';
  const mergeReadyState = parseArray(env.MERGE_READY_STATE, [
    'clean',
    'has_hooks',
    'unknown',
    'unstable',
  ]);

  const updateLabels = parseMergeLabels(env.UPDATE_LABELS, 'automerge');
  const updateMethod = env.UPDATE_METHOD ? String(env.UPDATE_METHOD) : 'merge';
  const updateRetries = parsePositiveInt('UPDATE_RETRIES', 1);
  const updateRetrySleep = parsePositiveInt('UPDATE_RETRY_SLEEP', 5000);

  const baseBranches = parseBranches(env.BASE_BRANCHES, '');

  const pullRequest = parsePullRequest(env.PULL_REQUEST);

  return {
    mergeLabels,
    mergeRemoveLabels,
    mergeMethod,
    mergeMethodLabels,
    mergeMethodLabelRequired,
    mergeForks,
    mergeCommitMessage,
    mergeCommitMessageRegex,
    mergeFilterAuthor,
    mergeRetries,
    mergeRetrySleep,
    mergeRequiredApprovals,
    mergeDeleteBranch,
    mergeDeleteBranchFilter,
    mergeErrorFail,
    mergeReadyState,
    updateLabels,
    updateMethod,
    updateRetries,
    updateRetrySleep,
    baseBranches,
    pullRequest,
  };
}

export function tmpdir<T>(callback: (path: string) => Promise<T>): Promise<T> {
  async function handle(path: string): Promise<T> {
    try {
      return await callback(path);
    } finally {
      await fse.remove(path);
    }
  }

  const { promise, resolve, reject } = Promise.withResolvers<T>();
  tmp.dir((err, path) => {
    if (err) {
      reject(err);
    } else {
      handle(path).then(resolve, reject);
    }
  });
  return promise;
}

export async function retry(
  retries: number,
  retrySleep: number,
  doInitial: () => string | Promise<string>,
  doRetry: () => string | Promise<string>,
  doFailed: () => unknown,
): Promise<boolean> {
  const initialResult: string = await doInitial();
  if (initialResult === 'success') {
    return true;
  } else if (initialResult === 'failure') {
    return false;
  } else if (initialResult !== 'retry') {
    throw new Error(`invalid return value: ${initialResult}`);
  }

  for (let run = 1; run <= retries; run++) {
    if (retrySleep === 0) {
      logger.info(`Retrying ... (${run}/${retries})`);
    } else {
      logger.info(`Retrying after ${retrySleep} ms ... (${run}/${retries})`);
      await sleep(retrySleep);
    }

    const retryResult: string = await doRetry();
    if (retryResult === 'success') {
      return true;
    } else if (retryResult === 'failure') {
      return false;
    } else if (retryResult !== 'retry') {
      throw new Error(`invalid return value: ${initialResult}`);
    }
  }

  await doFailed();
  return false;
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
