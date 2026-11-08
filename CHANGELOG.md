# Changelog

## [2.0.0](https://github.com/god464/automerge-action/compare/automerge-action-v1.0.0...automerge-action-v2.0.0) (2026-11-08)


### ⚠ BREAKING CHANGES

* rewrite action around pure decisions

### Features

* rewrite action around pure decisions ([796d5e6](https://github.com/god464/automerge-action/commit/796d5e6684082875cefba72c67ad777adf153813))


### Bug Fixes

* fix ([887bed0](https://github.com/god464/automerge-action/commit/887bed0bb8d2570ff664375f48bba0419aa370f8))
* fix bundle ([860032c](https://github.com/god464/automerge-action/commit/860032cc464db89e544ece7eb63504f0118a3bd0))
* **merge:** Cannot merge in case of commit message that requires a PR title or description ([f84dd31](https://github.com/god464/automerge-action/commit/f84dd310ea4a19890c70a4ff11ab282a872fb94b))
* remove unused ([d0a62a2](https://github.com/god464/automerge-action/commit/d0a62a257236534d26305d4c36cbb379d80f372a))
* ruleset-aware branch deletion and correct shallow-fetch deepening ([8ba2cfd](https://github.com/god464/automerge-action/commit/8ba2cfde91fcb53dc1307fcfa3951cf3eaba3c23))
* update GitHub Action to run on nodejs16. ([#198](https://github.com/god464/automerge-action/issues/198)) ([0a13b2e](https://github.com/god464/automerge-action/commit/0a13b2ef88adbf59601ac6675a187139225b8110))

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
