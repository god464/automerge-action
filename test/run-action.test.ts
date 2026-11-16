import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ok } from '@/result';
import { type ActionPlatform, readEvent, runAction } from '@/run-action';

import { createFakeClient, createFakeLogger, createUnusedGitRunner } from './fakes';

const pullRequestPayload = {
  action: 'labeled',
  repository: { name: 'repo', owner: { login: 'owner' } },
  pull_request: { number: 1 },
};

function createPlatform(overrides: Partial<ActionPlatform> = {}) {
  const outputs: Record<string, string | number> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const secrets: string[] = [];
  const logger = createFakeLogger();

  const platform: ActionPlatform = {
    inputs: { 'github-token': 'token' },
    eventName: 'pull_request',
    eventPath: '/event.json',
    logger,
    outputs: {
      setOutput: (name, value) => {
        outputs[name] = value;
      },
    },
    setSecret: (value) => secrets.push(value),
    setFailed: (message) => failures.push(message),
    error: (message) => errors.push(message),
    warning: (message) => warnings.push(message),
    readEvent: async () => ok(pullRequestPayload),
    createClient: () => createFakeClient(),
    createGit: () => createUnusedGitRunner(),
    sleep: async () => undefined,
    now: () => 0,
    cloneUrl: (token, repoFullName) => `https://${token}@github.com/${repoFullName}.git`,
    ...overrides,
  };

  return { platform, outputs, errors, warnings, failures, secrets, logger };
}

describe('runAction', () => {
  it('runs the event flow and writes action outputs', async () => {
    const { platform, outputs, errors, failures, secrets } = createPlatform();

    await runAction(platform);

    expect(secrets).toEqual(['token']);
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
    expect(outputs).toEqual({ 'merge-result': 'merged', 'pull-request-number': 1 });
  });

  it('reports missing configuration without creating clients', async () => {
    let clients = 0;
    const { platform, outputs, errors, failures, secrets } = createPlatform({
      inputs: {},
      createClient: () => {
        clients += 1;
        return createFakeClient();
      },
    });

    await runAction(platform);

    expect(errors).toEqual(['Missing required input: github-token']);
    expect(failures).toEqual(['Invalid action configuration (1 error(s))']);
    expect(secrets).toEqual([]);
    expect(outputs).toEqual({});
    expect(clients).toEqual(0);
  });

  it('formats invalid enum values', async () => {
    const { platform, errors } = createPlatform({
      inputs: { 'github-token': 'token', 'merge-method': 'fast-forward' },
    });

    await runAction(platform);

    expect(errors).toEqual([
      'Invalid value for merge-method: "fast-forward" (expected merge, squash, rebase)',
    ]);
  });

  it('warns about labels that are both required and blocking', async () => {
    const { platform, warnings } = createPlatform({
      inputs: { 'github-token': 'token', 'merge-labels': 'automerge,!automerge' },
    });

    await runAction(platform);

    expect(warnings).toEqual([
      'merge-labels: label "automerge" is both required and blocking; blocking wins',
    ]);
  });

  it('fails when the event environment is missing', async () => {
    let reads = 0;
    const { platform, failures } = createPlatform({
      eventPath: undefined,
      readEvent: async () => {
        reads += 1;
        return ok(pullRequestPayload);
      },
    });

    await runAction(platform);

    expect(failures).toEqual(['GITHUB_EVENT_PATH and GITHUB_EVENT_NAME must be set']);
    expect(reads).toEqual(0);
  });

  it('fails when the event payload cannot be read', async () => {
    const { platform, failures } = createPlatform({
      readEvent: async () => ({ ok: false, error: 'Failed to read event payload: missing' }),
    });

    await runAction(platform);

    expect(failures).toEqual(['Failed to read event payload: missing']);
  });

  it('writes skipped outputs for malformed and unsupported events', async () => {
    const malformed = createPlatform({ readEvent: async () => ok({ action: 'labeled' }) });
    const unsupported = createPlatform({ eventName: 'push' });

    await runAction(malformed.platform);
    await runAction(unsupported.platform);

    expect(malformed.warnings).toHaveLength(1);
    expect(malformed.outputs).toEqual({ 'merge-result': 'skipped', 'pull-request-number': 0 });
    expect(unsupported.warnings).toEqual(['Unsupported event: push']);
    expect(unsupported.outputs).toEqual({ 'merge-result': 'skipped', 'pull-request-number': 0 });
  });
});

describe('readEvent', () => {
  it('parses a JSON event payload and reports read failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'automerge-event-'));
    const eventPath = join(dir, 'event.json');
    await writeFile(eventPath, JSON.stringify(pullRequestPayload));

    try {
      expect(await readEvent(eventPath)).toEqual(ok(pullRequestPayload));
      expect(await readEvent(join(dir, 'missing.json'))).toMatchObject({
        ok: false,
        error: expect.stringContaining('Failed to read event payload:'),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
