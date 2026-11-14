export interface LabelFilter {
  readonly required: readonly string[];
  readonly blocking: readonly string[];
}

export interface ParsedLabelFilter {
  readonly filter: LabelFilter;
  readonly bothRequiredAndBlocking: readonly string[];
}

export type LabelSkipReason = 'blocking_label' | 'required_label_missing';

export function parseLabelFilter(
  value: string | undefined,
  defaultValue: string,
): ParsedLabelFilter {
  const entries = [
    ...new Set(
      (value == null ? defaultValue : value)
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
  const rawRequired = entries.filter((entry) => !entry.startsWith('!'));
  const blocking = [
    ...new Set(
      entries
        .filter((entry) => entry.startsWith('!'))
        .map((entry) => entry.slice(1).trim())
        .filter((entry) => entry.length > 0),
    ),
  ];

  return {
    filter: { required: rawRequired.filter((label) => !blocking.includes(label)), blocking },
    bothRequiredAndBlocking: rawRequired.filter((label) => blocking.includes(label)),
  };
}

export function labelSkipReason(
  labels: readonly string[],
  filter: LabelFilter,
): LabelSkipReason | null {
  const hasBlocking = filter.blocking.some((label) => labels.includes(label));
  if (hasBlocking) return 'blocking_label';

  const hasAllRequired = filter.required.every((label) => labels.includes(label));
  return hasAllRequired ? null : 'required_label_missing';
}

export function matchesLabelFilter(labels: readonly string[], filter: LabelFilter): boolean {
  return labelSkipReason(labels, filter) == null;
}
