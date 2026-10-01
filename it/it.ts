import { Octokit } from '@octokit/rest';
import { config as loadEnv } from 'dotenv';

import { executeLocally } from '../lib/api';
import { createConfig } from '../lib/common';
import type { Context } from '../lib/types';

async function main(): Promise<void> {
  loadEnv();

  const token = process.env.GITHUB_TOKEN;

  const octokit = new Octokit({
    baseUrl: 'https://api.github.com',
    auth: `token ${token}`,
    userAgent: 'pascalgn/automerge-action-it',
  });

  const config = createConfig({
    UPDATE_LABELS: 'it-update',
    MERGE_LABELS: 'it-merge',
    MERGE_REQUIRED_APPROVALS: '0',
    MERGE_REMOVE_LABELS: 'it-merge',
    MERGE_RETRIES: '3',
    MERGE_RETRY_SLEEP: '2000',
    MERGE_ERROR_FAIL: 'true',
  });

  const context: Context = { token: token ?? '', octokit, config };

  const url = process.env.URL;
  if (!url) {
    throw new Error('environment variable URL not set!');
  }

  // `@actions/core` is ESM-only while this script runs as CommonJS under `tsx`,
  // so a static import cannot resolve; load it on demand instead.
  const { setOutput } = await import('@actions/core');

  await executeLocally(context, url, { setOutput });
}

main().catch((e) => {
  process.exitCode = 1;
  console.error(e);
});
