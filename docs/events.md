# Events and pull request resolution

## Supported events

| Event                 | Accepted activity                                                                                     | Target                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pull_request`        | `labeled`, `unlabeled`, `synchronize`, `opened`, `edited`, `ready_for_review`, `reopened`, `unlocked` | Payload PR number.                                                     |
| `pull_request_review` | `submitted` with `review.state = approved`                                                            | Payload PR number.                                                     |
| `workflow_run`        | `completed` + `conclusion = success`; `event = pull_request`                                          | Associated PRs, or the commit SHA when the PR list is empty (fork PR). |
| `workflow_run`        | `completed` + `conclusion = success`; `event = push`                                                  | Open PRs whose base is `head_branch`; update only.                     |
| `check_suite`         | `completed` + `conclusion = success`                                                                  | Associated PRs, or the commit SHA.                                     |
| `status`              | `state = success`                                                                                     | PRs associated with the commit SHA.                                    |

Other events, or supported events in an inapplicable state, resolve to
`ignored` or `unsupported`; the action outputs `skipped` with a warning or an
informational log.

## Why `workflow_run` is the reliable Build Check trigger

A Build Check run by GitHub Actions on `pull_request` is not delivered as a
`check_suite` event; GitHub suppresses `check_suite` workflow runs for check
suites created by GitHub Actions. It is also a check run, not a commit status,
so it is not a `status` event. Use `workflow_run` for Build Check.

A `workflow_run` payload contains the event that triggered the workflow:

- `event: pull_request`: resolve the PR from `pull_requests`, or from
  `head_sha` when the PR list is empty (fork PRs often have an empty list).
- `event: push`: `head_branch` is the pushed base branch. The action lists open
  PRs with `base = head_branch` and updates them; it never merges them.

`pull_request` workflows are not re-run when the base branch advances. The
action's post-merge fan-out handles the common case: after a successful merge
it updates other open PRs based on the same base. Their own Build Check
completion then triggers the next run.

## Commit SHA lookup

`status` and `check_suite` do not contain a PR number. The action uses
`GET /repos/{owner}/{repo}/commits/{sha}/pulls` and keeps only open PRs. This is
more accurate than matching branch names: it works for fork PRs and for PRs
older than the list page size.

## Limits

- A target list is capped at 10 pull requests.
- The same number is de-duplicated before processing.
- Multiple pull requests are processed sequentially; the outputs expose the
  first result.

## Unsupported events

`pull_request_target`, `push`, `schedule`, `repository_dispatch`,
`issue_comment`, `workflow_dispatch`, and `check_run` are not supported. When
the action is invoked for one of them, it logs a warning and outputs
`merge-result=skipped` and `pull-request-number=0`. This keeps workflows that
subscribe to extra events from failing.
