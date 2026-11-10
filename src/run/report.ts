import type {OutputSink} from '../actions/outputs';
import type {RunReport} from './result';

export const OUTPUT_MERGE_RESULT = 'merge-result';
export const OUTPUT_PULL_REQUEST_NUMBER = 'pull-request-number';

export function writeReport(report: RunReport, outputs: OutputSink): void {
  outputs.setOutput(OUTPUT_MERGE_RESULT, report.primary.result);
  outputs.setOutput(OUTPUT_PULL_REQUEST_NUMBER, report.primary.pullRequestNumber ?? 0);
}
