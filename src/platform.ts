import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { readActionInputs } from '@/actions/inputs';
import { actionsLogger } from '@/actions/logger';
import { actionsOutputs } from '@/actions/outputs';
import { createGitRunner } from '@/git/command';
import { createGitHubClient } from '@/github/octokit-client';
import { readEvent, type ActionPlatform } from '@/run-action';

export function createPlatform(): ActionPlatform {
  return {
    inputs: readActionInputs(core.getInput),
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    eventPath: process.env.GITHUB_EVENT_PATH,
    logger: actionsLogger,
    outputs: actionsOutputs,
    setSecret: core.setSecret,
    setFailed: core.setFailed,
    error: core.error,
    warning: core.warning,
    readEvent,
    createClient: (token) => createGitHubClient(github.getOctokit(token)),
    createGit: createGitRunner,
    sleep,
    now: Date.now,
    cloneUrl: (token, repoFullName) =>
      `https://x-access-token:${token}@github.com/${repoFullName}.git`,
  };
}
