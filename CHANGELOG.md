# Changelog

## [1.0.0](https://github.com/god464/automerge-action/releases/tag/v1.0.0) (2026-11-08)

### BREAKING CHANGES

- Configuration moved from `MERGE_*`/`UPDATE_*` environment variables to
  action inputs. Outputs were renamed to `merge-result` and
  `pull-request-number`; `author_filtered` was removed.
- The action is now a pure decision core with a thin side-effect shell. Retry,
  label-removal, branch-deletion, approval-count, fork-blocking, base-branch,
  arbitrary-PR, and custom-log configuration were removed.
- Only `pull_request`, `pull_request_review`, `workflow_run`, `check_suite`, and
  `status` events are supported.

### Features

- Independent pure decisions for updating and merging.
- Fixed mergeability mapping with a small bounded retry for unknown states.
- Post-merge update fan-out for other stale pull requests.
- `workflow_run` base-branch push resolution and commit-SHA lookup for
  `status`/`check_suite`.
