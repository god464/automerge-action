# Changelog

## [1.0.1](https://github.com/god464/automerge-action/compare/v1.0.0...v1.0.1) (2026-11-11)


### Bug Fixes

* fix config ([524c7f9](https://github.com/god464/automerge-action/commit/524c7f9e9c726058094333746649aa6888d8c2c9))
* fix format ([9062e78](https://github.com/god464/automerge-action/commit/9062e78c5a839b72e1d0c1a680e525faafc92b98))
* fix imports ([11c4741](https://github.com/god464/automerge-action/commit/11c4741d16af320daf737607bb71111d1c3f8e98))
* remove unused ([d0a62a2](https://github.com/god464/automerge-action/commit/d0a62a257236534d26305d4c36cbb379d80f372a))

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
