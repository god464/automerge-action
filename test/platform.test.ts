import process from 'node:process';

import * as core from '@actions/core';
import { describe, expect, it, vi } from 'vitest';

import { createPlatform } from '@/platform';

vi.mock('@actions/core', () => ({
  debug: vi.fn<(message: string) => void>(),
  info: vi.fn<(message: string) => void>(),
  warning: vi.fn<(message: string) => void>(),
  setOutput: vi.fn<(name: string, value: unknown) => void>(),
  getInput: vi.fn<(name: string) => string>((name) => `value:${name}`),
  setSecret: vi.fn<(value: string) => void>(),
  setFailed: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
}));

describe('createPlatform', () => {
  it('reads action inputs, event context, and builds runtime adapters', () => {
    const previousEventName = process.env.GITHUB_EVENT_NAME;
    const previousEventPath = process.env.GITHUB_EVENT_PATH;
    process.env.GITHUB_EVENT_NAME = 'pull_request';
    process.env.GITHUB_EVENT_PATH = '/event.json';

    try {
      const platform = createPlatform();

      expect(platform.inputs['github-token']).toEqual('value:github-token');
      expect(platform.eventName).toEqual('pull_request');
      expect(platform.eventPath).toEqual('/event.json');
      expect(platform.cloneUrl('token', 'owner/repo')).toEqual(
        'https://x-access-token:token@github.com/owner/repo.git',
      );
      expect(platform.readEvent).toBeTypeOf('function');
      expect(platform.createGit(platform.logger)).toHaveProperty('run');
      expect(platform.createClient('token')).toHaveProperty('getPullRequest');
      expect(core.getInput).toHaveBeenCalled();
    } finally {
      if (previousEventName == null) {
        delete process.env.GITHUB_EVENT_NAME;
      } else {
        process.env.GITHUB_EVENT_NAME = previousEventName;
      }
      if (previousEventPath == null) {
        delete process.env.GITHUB_EVENT_PATH;
      } else {
        process.env.GITHUB_EVENT_PATH = previousEventPath;
      }
    }
  });
});
