import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { getInput, setSecret, setFailed, error, warning } from '@actions/core';
import { getOctokit } from '@actions/github';

import { readActionInputs } from '@/actions/inputs';
import { actionsLogger } from '@/actions/logger';
import { actionsOutputs } from '@/actions/outputs';
import { createGitRunner } from '@/git/command';
import { createGitHubClient } from '@/github/octokit-client';
import { readEvent, type ActionPlatform } from '@/run-action';

export function createPlatform(): ActionPlatform {
  return {
    inputs: readActionInputs(getInput),
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    eventPath: process.env.GITHUB_EVENT_PATH,
    logger: actionsLogger,
    outputs: actionsOutputs,
    setSecret,
    setFailed,
    error,
    warning,
    readEvent,
    createClient: (token) => createGitHubClient(getOctokit(token)),
    createGit: (logger, token) => createGitRunner(logger, { token }),
    sleep,
    now: Date.now,
    cloneUrl: (repoFullName) => `https://github.com/${repoFullName}.git`,
  };
}
