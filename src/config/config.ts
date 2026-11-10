import {err, ok, type Result} from '../result.js';
import {type LabelFilter, parseLabelFilter} from '../domain/labels.js';
import {
  MERGE_COMMIT_MESSAGES,
  MERGE_METHODS,
  type MergeCommitMessage,
  type MergeMethod,
  UPDATE_METHODS,
  type UpdateMethod,
} from '../domain/methods';

export const INPUT_NAMES = [
  'github-token',
  'merge-labels',
  'merge-method',
  'merge-commit-message',
  'update-labels',
  'update-method',
] as const;

export type ActionInputs = Readonly<Record<string, string | undefined>>;

export interface LabelConflict {
  readonly input: 'merge-labels' | 'update-labels';
  readonly label: string;
}

export interface Config {
  readonly githubToken: string;
  readonly mergeLabels: LabelFilter;
  readonly mergeMethod: MergeMethod;
  readonly mergeCommitMessage: MergeCommitMessage;
  readonly updateLabels: LabelFilter;
  readonly updateMethod: UpdateMethod;
  readonly labelConflicts: readonly LabelConflict[];
}

export type ConfigError =
  | { readonly kind: 'missing_input'; readonly input: 'github-token' }
  | {
      readonly kind: 'invalid_enum';
      readonly input: string;
      readonly value: string;
      readonly allowed: readonly string[];
    };

interface EnumParserInput<T extends string> {
  readonly inputs: ActionInputs;
  readonly input: string;
  readonly allowed: readonly T[];
  readonly fallback: T;
}

function parseEnum<T extends string>({
  inputs,
  input,
  allowed,
  fallback,
}: EnumParserInput<T>): Result<T, readonly ConfigError[]> {
  const raw = inputs[input];
  const value = raw == null || raw.trim().length === 0 ? fallback : raw.trim().toLowerCase();

  return (allowed as readonly string[]).includes(value)
    ? ok(value as T)
    : err([{ kind: 'invalid_enum', input, value: raw ?? '', allowed }]);
}

interface ParsedEnums {
  readonly mergeMethod: MergeMethod;
  readonly mergeCommitMessage: MergeCommitMessage;
  readonly updateMethod: UpdateMethod;
}

function parseEnums(inputs: ActionInputs): Result<ParsedEnums, readonly ConfigError[]> {
  const mergeMethod = parseEnum({
    inputs,
    input: 'merge-method',
    allowed: MERGE_METHODS,
    fallback: 'merge',
  });
  if (!mergeMethod.ok) {
    return mergeMethod;
  }

  const mergeCommitMessage = parseEnum({
    inputs,
    input: 'merge-commit-message',
    allowed: MERGE_COMMIT_MESSAGES,
    fallback: 'automatic',
  });
  if (!mergeCommitMessage.ok) {
    return mergeCommitMessage;
  }

  const updateMethod = parseEnum({
    inputs,
    input: 'update-method',
    allowed: UPDATE_METHODS,
    fallback: 'merge',
  });
  if (!updateMethod.ok) {
    return updateMethod;
  }

  return ok({
    mergeMethod: mergeMethod.value,
    mergeCommitMessage: mergeCommitMessage.value,
    updateMethod: updateMethod.value,
  });
}

export function parseConfig(inputs: ActionInputs): Result<Config, readonly ConfigError[]> {
  const token = inputs['github-token']?.trim() ?? '';
  if (token.length === 0) {
    return err([{ kind: 'missing_input', input: 'github-token' }]);
  }

  const enums = parseEnums(inputs);
  if (!enums.ok) {
    return enums;
  }

  const mergeLabels = parseLabelFilter(inputs['merge-labels'], 'automerge');
  const updateLabels = parseLabelFilter(inputs['update-labels'], 'automerge');
  const mergeConflicts: readonly LabelConflict[] = mergeLabels.bothRequiredAndBlocking.map(
    (label) => ({ input: 'merge-labels', label }),
  );
  const updateConflicts: readonly LabelConflict[] = updateLabels.bothRequiredAndBlocking.map(
    (label) => ({ input: 'update-labels', label }),
  );

  return ok({
    githubToken: token,
    mergeLabels: mergeLabels.filter,
    mergeMethod: enums.value.mergeMethod,
    mergeCommitMessage: enums.value.mergeCommitMessage,
    updateLabels: updateLabels.filter,
    updateMethod: enums.value.updateMethod,
    labelConflicts: [...mergeConflicts, ...updateConflicts],
  });
}
