# Changelog

## [1.0.4](https://github.com/god464/automerge-action/compare/v1.0.3...v1.0.4) (2026-11-22)


### Bug Fixes

* target fork repositories safely and harden updates ([340cd4d](https://github.com/god464/automerge-action/commit/340cd4d144bb74454bda1076dd2c9eef001841d1))

## [1.0.3](https://github.com/god464/automerge-action/compare/v1.0.2...v1.0.3) (2026-11-18)

### Bug Fixes

- bound the entire rebase flow with one deadline ([3df1460](https://github.com/god464/automerge-action/commit/3df1460585f7fdcb77b13fcdfd2361131005acfe))
- fail closed when merge state or compare result is unknown ([4087560](https://github.com/god464/automerge-action/commit/40875602e0eae1390a9b6c4e01667ea70fffd1ff))
- pass git auth via config env and harden test fakes ([e5cf4ed](https://github.com/god464/automerge-action/commit/e5cf4eda168d9f0f0d09dea7faf053570b1c3aaa))
- reject malformed GitHub API and webhook payloads ([d1fc860](https://github.com/god464/automerge-action/commit/d1fc86058c05a59983fc3a4cf65bdcede957c903))

## [1.0.2](https://github.com/god464/automerge-action/compare/v1.0.1...v1.0.2) (2026-11-15)

### Bug Fixes

- harden action execution and simplify internals ([bf9225e](https://github.com/god464/automerge-action/commit/bf9225e7ca873469ea72a3ac3b3ad28f6b15dcba))

## [1.0.1](https://github.com/god464/automerge-action/compare/v1.0.0...v1.0.1) (2026-11-11)

### Bug Fixes

- fix config ([524c7f9](https://github.com/god464/automerge-action/commit/524c7f9e9c726058094333746649aa6888d8c2c9))
- fix format ([2473192](https://github.com/god464/automerge-action/commit/247319230129eae50769fdfbfafe1265e95adb07))
- fix format ([9062e78](https://github.com/god464/automerge-action/commit/9062e78c5a839b72e1d0c1a680e525faafc92b98))
- fix imports ([11c4741](https://github.com/god464/automerge-action/commit/11c4741d16af320daf737607bb71111d1c3f8e98))
- remove unused ([d0a62a2](https://github.com/god464/automerge-action/commit/d0a62a257236534d26305d4c36cbb379d80f372a))

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
