import * as core from '@actions/core';

export interface OutputSink {
  readonly setOutput: (name: string, value: string | number) => void;
}

export const actionsOutputs: OutputSink = {
  setOutput: (name, value) => core.setOutput(name, value),
};
