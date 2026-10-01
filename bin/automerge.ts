#!/usr/bin/env node

import process from 'node:process';

import fse from 'fs-extra';
import { ArgumentParser } from 'argparse';
import { Octokit } from '@octokit/rest';
import { setOutput } from '@actions/core';

import { ClientError, logger, createConfig } from '../lib/common';
import { executeLocally, executeGitHubAction } from '../lib/api';
import type { ActionOutputs, Context, EventData } from '../lib/types';

import pkg from '../package.json';

const OLD_CONFIG = [
  'MERGE_LABEL',
  'UPDATE_LABEL',
  'LABELS',
  'AUTOMERGE',
  'AUTOREBASE',
  'COMMIT_MESSAGE_TEMPLATE',
  'TOKEN',
];

const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';

async function main(): Promise<void> {
  const parser = new ArgumentParser({
    prog: pkg.name,
    add_help: true,
    description: pkg.description,
  });
  parser.add_argument('-v', '--version', {
    action: 'version',
    version: pkg.version,
    help: 'Show version number and exit',
  });
  parser.add_argument('url', {
    metavar: '<url>',
    nargs: '?',
    help: 'GitHub URL to process instead of environment variables',
  });

  const args = parser.parse_args() as { url?: string };

  if (process.env.LOG === 'TRACE') {
    logger.level = 'trace';
  } else if (process.env.LOG === 'DEBUG') {
    logger.level = 'debug';
  } else if (process.env.LOG && process.env.LOG.length > 0) {
    logger.error('Invalid log level:', process.env.LOG);
  }

  checkOldConfig();

  const token = env('GITHUB_TOKEN');

  const octokit = new Octokit({
    baseUrl: GITHUB_API_URL,
    auth: `token ${token}`,
    userAgent: 'pascalgn/automerge-action',
  });

  const config = createConfig(process.env);
  logger.debug('Configuration:', config);

  const context: Context = { token, octokit, config };
  const outputs: ActionOutputs = { setOutput };

  if (args.url) {
    await executeLocally(context, args.url, outputs);
  } else {
    const eventPath = env('GITHUB_EVENT_PATH');
    const eventName = env('GITHUB_EVENT_NAME');

    const eventDataStr = await fse.readFile(eventPath, 'utf8');
    const eventData = JSON.parse(eventDataStr) as EventData;

    await executeGitHubAction(context, eventName, eventData, outputs);
  }
}

function checkOldConfig(): void {
  let error = false;
  for (const old of OLD_CONFIG) {
    if (process.env[old] != null) {
      logger.error('Old configuration option present:', old);
      error = true;
    }
  }
  if (error) {
    logger.error(
      'You have passed configuration options that were used by an old ' +
        'version of this action. Please see ' +
        'https://github.com/pascalgn/automerge-action for the latest ' +
        'documentation of the configuration options!',
    );
    throw new Error(`old configuration present!`);
  }
}

function env(name: string): string {
  const val = process.env[name];
  if (!val || !val.length) {
    throw new ClientError(`environment variable ${name} not set!`);
  }
  return val;
}

main().catch((e) => {
  if (e instanceof ClientError) {
    process.exitCode = 2;
    logger.error(e);
  } else {
    process.exitCode = 1;
    logger.error(e);
  }
});
