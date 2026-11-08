export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export const UPDATE_METHODS = ['merge', 'rebase'] as const;
export type UpdateMethod = (typeof UPDATE_METHODS)[number];

export const MERGE_COMMIT_MESSAGES = ['automatic', 'pull-request-title'] as const;
export type MergeCommitMessage = (typeof MERGE_COMMIT_MESSAGES)[number];
