import { INPUT_NAMES, type ActionInputs } from '../config/config.js';

export function readActionInputs(getInput: (name: string) => string): ActionInputs {
  return Object.fromEntries(INPUT_NAMES.map((name) => [name, getInput(name)]));
}
