export type MergeResult = 'skipped' | 'not_ready' | 'merge_failed' | 'merged';

export interface RunResult {
  readonly result: MergeResult;
  readonly pullRequestNumber: number | undefined;
}

export interface RunReport {
  readonly primary: RunResult;
  readonly all: readonly RunResult[];
}

export function skippedReport(): RunReport {
  return { primary: { result: 'skipped', pullRequestNumber: undefined }, all: [] };
}
