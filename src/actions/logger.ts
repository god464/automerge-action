import { debug, info, warning } from '@actions/core';

export interface Logger {
  readonly debug: (message: string) => void;
  readonly info: (message: string) => void;
  readonly warning: (message: string) => void;
}

export const actionsLogger: Logger = {
  debug: (message) => debug(message),
  info: (message) => info(message),
  warning: (message) => warning(message),
};
