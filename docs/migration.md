# Migration from the upstream environment-variable interface

The action is a breaking refactor. Configuration is passed through action
`inputs`; `MERGE_*`, `UPDATE_*`, `GITHUB_TOKEN`, `PULL_REQUEST`, `BASE_BRANCHES`,
`MAX_PR_COUNT`, and `LOG` environment variables are no longer read.

## Inputs

| Old environment variable | New input              |
| ------------------------ | ---------------------- |
| `MERGE_LABELS`           | `merge-labels`         |
| `MERGE_METHOD`           | `merge-method`         |
| `MERGE_COMMIT_MESSAGE`   | `merge-commit-message` |
| `UPDATE_LABELS`          | `update-labels`        |
| `UPDATE_METHOD`          | `update-method`        |
| `GITHUB_TOKEN`           | `github-token`         |

`merge-commit-message` now accepts only `automatic` and `pull-request-title`.
The upstream `pull-request-description`, `pull-request-title-and-description`,
and placeholder templates are removed.

## Outputs

| Old output          | New output            |
| ------------------- | --------------------- |
| `mergeResult`       | `merge-result`        |
| `pullRequestNumber` | `pull-request-number` |

`merge-result` values are `skipped`, `not_ready`, `merge_failed`, and `merged`.
The upstream `author_filtered` value is removed together with
`MERGE_FILTER_AUTHOR`.

## Removed configuration and behavior

| Removed                                                                      | Consequence                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MERGE_REMOVE_LABELS`                                                        | Labels are not removed after merging.                                                                                                                                        |
| `MERGE_DELETE_BRANCH`, `MERGE_DELETE_BRANCH_FILTER`                          | Branches are not deleted. Use GitHub's automatic branch deletion or a separate workflow.                                                                                     |
| `MERGE_REQUIRED_APPROVALS`                                                   | The action does not count reviews; required reviews are enforced by GitHub branch protection.                                                                                |
| `MERGE_FILTER_AUTHOR`                                                        | No author filter.                                                                                                                                                            |
| `MERGE_FORKS`                                                                | Fork PRs are always considered. Token permissions and the update path may still prevent updating a fork branch.                                                              |
| `MERGE_METHOD_LABELS`, `MERGE_METHOD_LABEL_REQUIRED`                         | The merge method is always the `merge-method` input.                                                                                                                         |
| `MERGE_COMMIT_MESSAGE_REGEX`                                                 | Commit messages are no longer extracted from the PR body.                                                                                                                    |
| `MERGE_ERROR_FAIL`                                                           | A `merge_failed` result does not fail the action; check the output in a later step if needed.                                                                                |
| `MERGE_READY_STATE`                                                          | Fixed rule: `clean`, `has_hooks`, and `unstable` are ready; `blocked`, `behind`, `dirty`, and `draft` are not; unknown/missing is retried up to 3 attempts, 2 seconds apart. |
| `MERGE_RETRIES`, `MERGE_RETRY_SLEEP`, `UPDATE_RETRIES`, `UPDATE_RETRY_SLEEP` | Only the fixed unknown-state retry remains.                                                                                                                                  |
| `BASE_BRANCHES`                                                              | No base branch filter. Use workflow-level branch filters or separate workflows.                                                                                              |
| `PULL_REQUEST`                                                               | No arbitrary pull request targeting.                                                                                                                                         |
| `MAX_PR_COUNT`                                                               | Fixed at 10 per list/fan-out operation.                                                                                                                                      |
| `LOG`                                                                        | Use `ACTIONS_STEP_DEBUG` for debug logs; the action uses `core.debug`/`core.info`/`core.warning`.                                                                            |

## Removed events

`pull_request_target`, `push`, `schedule`, `repository_dispatch`,
`issue_comment`, `workflow_dispatch`, and `check_run` are unsupported. If the
workflow is invoked for one of them, the action logs a warning and outputs
`skipped`/`0` instead of failing.

To keep updating other stale PRs after a merge, the action performs a bounded
post-merge fan-out (update-only) for open PRs based on the same base branch.
`workflow_run` events triggered by a push to the base branch also use a
base-branch lookup and update-only mode.

## Token changes

The token is now an input. It is registered with `core.setSecret` and is never
logged. The action requires:

```yaml
permissions:
  contents: write
  pull-requests: write
```

`GITHUB_TOKEN` still does not trigger `push` workflows when it merges to a base
branch. Updating a PR branch emits `pull_request synchronize`; since June 2026,
GitHub may place workflow runs caused by bot-updated PRs in an approval-required
state, even for same-repository branches. Use a GitHub App/PAT token if the CI
must run unattended, or approve the runs manually.

Fork PRs opened through `pull_request` receive a read-only `GITHUB_TOKEN`; use
`workflow_run` or a PAT/App token if write access is required.

## Workflow conversion

Before:

```yaml
- uses: god464/automerge-action@main
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    MERGE_LABELS: automerge,!wip
    MERGE_METHOD: squash
    UPDATE_LABELS: automerge
    UPDATE_METHOD: merge
```

After:

```yaml
- uses: god464/automerge-action@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    merge-labels: automerge,!wip
    merge-method: squash
    update-labels: automerge
    update-method: merge
```
