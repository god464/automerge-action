import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import * as core from '@actions/core';
import { readActionInputs } from './actions/inputs';
import { actionsLogger } from './actions/logger';
import { actionsOutputs } from './actions/outputs';
import { type ConfigError, parseConfig } from './config/config';
import { parseEvent } from './events/parse';
import { createGitRunner } from './git/command';
import { createGitHubClient } from './github/octokit-client';
import { assertNever, err, ok, type Result } from './result';
import { writeReport } from './run/report';
import { runFromEvent } from './run/run';
import { skippedReport } from './run/result';

function formatConfigError(error: ConfigError): string {
  switch (error.kind) {
    case 'missing_input':
      return `Missing required input: ${error.input}`;
    case 'invalid_enum':
      return `Invalid value for ${error.input}: "${error.value}" (expected ${error.allowed.join(', ')})`;
    default:
      return assertNever(error);
  }
}

async function readEvent(path: string): Promise<Result<unknown, string>> {
  try {
    return ok(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    return err(
      `Failed to read event payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  const configResult = parseConfig(readActionInputs(core.getInput));
  if (!configResult.ok) {
    configResult.error.forEach((error) => core.error(formatConfigError(error)));
    core.setFailed(`Invalid action configuration (${configResult.error.length} error(s))`);
    return;
  }

  const config = configResult.value;
  core.setSecret(config.githubToken);
  config.labelConflicts.forEach((conflict) => {
    core.warning(
      `${conflict.input}: label "${conflict.label}" is both required and blocking; blocking wins`,
    );
  });

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventPath || !eventName) {
    core.setFailed('GITHUB_EVENT_PATH and GITHUB_EVENT_NAME must be set');
    return;
  }

  const payload = await readEvent(eventPath);
  if (!payload.ok) {
    core.setFailed(payload.error);
    return;
  }

  const event = parseEvent(eventName, payload.value);
  if (!event.ok) {
    core.warning(`Ignoring malformed ${event.error.eventName} payload: ${event.error.detail}`);
    writeReport(skippedReport(), actionsOutputs);
    return;
  }
  if (event.value.kind === 'unsupported') {
    core.warning(`Unsupported event: ${event.value.eventName}`);
    writeReport(skippedReport(), actionsOutputs);
    return;
  }

  const client = createGitHubClient({
    token: config.githubToken,
    baseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
  });
  const git = createGitRunner(actionsLogger);
  const report = await runFromEvent(
    {
      config,
      client,
      logger: actionsLogger,
      git,
      sleep,
      now: Date.now,
      cloneUrl: (repoFullName) =>
        `https://x-access-token:${config.githubToken}@github.com/${repoFullName}.git`,
    },
    event.value,
  );

  writeReport(report, actionsOutputs);
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
