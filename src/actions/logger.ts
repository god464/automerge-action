import * as core from '@actions/core';

export interface Logger {
  readonly debug: (message: string) => void;
  readonly info: (message: string) => void;
  readonly warning: (message: string) => void;
}

export const actionsLogger: Logger = {
  debug: (message) => core.debug(message),
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
};
