import { type ActionInputs, INPUT_NAMES } from '@/config/config';

export function readActionInputs(getInput: (name: string) => string): ActionInputs {
  return Object.fromEntries(INPUT_NAMES.map((name) => [name, getInput(name)]));
}
