import { readFile } from 'node:fs/promises';

import type { Logger } from '@/actions/logger';
import type { OutputSink } from '@/actions/outputs';
import { type ActionInputs, type Config, type ConfigError, parseConfig } from '@/config/config';
import { parseEvent } from '@/events/parse';
import type { GitRunner } from '@/git/command';
import type { GitHubClient } from '@/github/client';
import { assertNever, err, ok, type Result } from '@/result';
import { writeReport } from '@/run/report';
import { skippedReport } from '@/run/result';
import { runFromEvent } from '@/run/run';

export interface ActionPlatform {
  readonly inputs: ActionInputs;
  readonly eventName: string;
  readonly eventPath: string | undefined;
  readonly logger: Logger;
  readonly outputs: OutputSink;
  readonly setSecret: (value: string) => void;
  readonly setFailed: (message: string) => void;
  readonly error: (message: string) => void;
  readonly warning: (message: string) => void;
  readonly readEvent: (path: string) => Promise<Result<unknown, string>>;
  readonly createClient: (token: string) => GitHubClient;
  readonly createGit: (logger: Logger) => GitRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly cloneUrl: (token: string, repoFullName: string) => string;
}

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

export async function readEvent(path: string): Promise<Result<unknown, string>> {
  try {
    return ok(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    return err(
      `Failed to read event payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateConfig(platform: ActionPlatform): Config | null {
  const result = parseConfig(platform.inputs);
  if (result.ok) return result.value;

  for (const error of result.error) {
    platform.error(formatConfigError(error));
  }
  platform.setFailed(`Invalid action configuration (${result.error.length} error(s))`);
  return null;
}

function runtimeFor(platform: ActionPlatform, config: Config) {
  return {
    config,
    client: platform.createClient(config.githubToken),
    logger: platform.logger,
    git: platform.createGit(platform.logger),
    sleep: platform.sleep,
    now: platform.now,
    cloneUrl: (repoFullName: string) => platform.cloneUrl(config.githubToken, repoFullName),
  };
}

export async function runAction(platform: ActionPlatform): Promise<void> {
  const config = validateConfig(platform);
  if (config == null) return;

  platform.setSecret(config.githubToken);
  for (const conflict of config.labelConflicts) {
    platform.warning(
      `${conflict.input}: label "${conflict.label}" is both required and blocking; blocking wins`,
    );
  }

  if (!platform.eventPath || !platform.eventName) {
    platform.setFailed('GITHUB_EVENT_PATH and GITHUB_EVENT_NAME must be set');
    return;
  }

  const payload = await platform.readEvent(platform.eventPath);
  if (!payload.ok) {
    platform.setFailed(payload.error);
    return;
  }

  const event = parseEvent(platform.eventName, payload.value);
  if (!event.ok) {
    platform.warning(`Ignoring malformed ${event.error.eventName} payload: ${event.error.detail}`);
    writeReport(skippedReport(), platform.outputs);
    return;
  }
  if (event.value.kind === 'unsupported') {
    platform.warning(`Unsupported event: ${event.value.eventName}`);
    writeReport(skippedReport(), platform.outputs);
    return;
  }

  const report = await runFromEvent(runtimeFor(platform, config), event.value);
  writeReport(report, platform.outputs);
}
