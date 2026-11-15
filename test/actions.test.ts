import * as core from '@actions/core';
import { describe, expect, it, vi } from 'vitest';

import { readActionInputs } from '../src/actions/inputs';
import { actionsLogger } from '../src/actions/logger';
import { actionsOutputs } from '../src/actions/outputs';

vi.mock('@actions/core', () => ({
  debug: vi.fn<(message: string) => void>(),
  info: vi.fn<(message: string) => void>(),
  warning: vi.fn<(message: string) => void>(),
  setOutput: vi.fn<(name: string, value: unknown) => void>(),
}));

describe('action adapters', () => {
  it('reads every documented input', () => {
    const names: string[] = [];

    expect(
      readActionInputs((name) => {
        names.push(name);
        return `value:${name}`;
      }),
    ).toEqual({
      'github-token': 'value:github-token',
      'merge-labels': 'value:merge-labels',
      'merge-method': 'value:merge-method',
      'merge-commit-message': 'value:merge-commit-message',
      'update-labels': 'value:update-labels',
      'update-method': 'value:update-method',
    });
    expect(names).toHaveLength(6);
  });

  it('routes log levels and outputs to @actions/core', () => {
    actionsLogger.debug('debug');
    actionsLogger.info('info');
    actionsLogger.warning('warning');
    actionsOutputs.setOutput('name', 7);

    expect(core.debug).toHaveBeenCalledWith('debug');
    expect(core.info).toHaveBeenCalledWith('info');
    expect(core.warning).toHaveBeenCalledWith('warning');
    expect(core.setOutput).toHaveBeenCalledWith('name', 7);
  });
});
