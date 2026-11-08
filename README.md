# automerge-action

GitHub Action that automates two independent tasks for pull requests:

- update a pull request branch when it is behind its base branch;
- merge a pull request when GitHub reports it as mergeable and the configured
  labels match.

This repository is a fork of
[pascalgn/automerge-action](https://github.com/pascalgn/automerge-action)
(MIT). The implementation has been rewritten around pure decision functions and
a thin side-effect shell; the configuration is passed through action `inputs`
instead of environment variables.

## Usage

Create `.github/workflows/automerge.yml`:

```yaml
name: automerge

on:
  pull_request:
    types:
      - labeled
      - unlabeled
      - synchronize
      - opened
      - edited
      - ready_for_review
      - reopened
      - unlocked
  pull_request_review:
    types:
      - submitted
  workflow_run:
    workflows:
      - Build Check
    types:
      - completed
  check_suite:
    types:
      - completed
  status: {}

permissions:
  contents: write
  pull-requests: write

jobs:
  automerge:
    if: ${{ github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    steps:
      - id: automerge
        name: automerge
        uses: god464/automerge-action@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          merge-labels: automerge
          merge-method: squash
          update-labels: automerge
          update-method: merge

      - name: feedback
        if: ${{ steps.automerge.outputs.merge-result == 'merged' }}
        run: echo "Merged pull request #${{ steps.automerge.outputs.pull-request-number }}"
```

Pin `uses:` to a commit SHA or release tag for production use. The example uses
`@main` because this fork does not publish the upstream version numbers.

## Inputs

| Input                  | Required | Default     | Description                                                                                                                                             |
| ---------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`         | yes      | –           | Token used for all GitHub API calls. It needs `contents: write` and `pull-requests: write`. The action registers it with `core.setSecret`.              |
| `merge-labels`         | no       | `automerge` | Comma-separated labels required to merge. Prefix a label with `!` to block merging when it is present. Empty string means no label filter.              |
| `merge-method`         | no       | `merge`     | `merge`, `squash`, or `rebase`.                                                                                                                         |
| `merge-commit-message` | no       | `automatic` | `automatic` (GitHub's default message) or `pull-request-title` (use the PR title as the commit title).                                                  |
| `update-labels`        | no       | `automerge` | Comma-separated labels required to update the branch. Prefix a label with `!` to block updating when it is present. Empty string means no label filter. |
| `update-method`        | no       | `merge`     | `merge` (merge the base into the PR head) or `rebase` (rebase the PR head onto the base).                                                               |

Label matching is exact and case-sensitive. If the same label appears both as a
required label and as a blocking (`!`) label, blocking wins and the action emits
a warning. Empty entries (including a lone `!`) are ignored. GitHub label names
containing commas cannot be expressed in this comma-separated format.

`merge-method` and `update-method` are independent: for example, update with a
merge commit, then squash-merge the PR.

## Outputs

| Output                | Values                                           | Description                                                                                                       |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `merge-result`        | `skipped`, `not_ready`, `merge_failed`, `merged` | Result of the merge decision or merge API call.                                                                   |
| `pull-request-number` | number, or `0`                                   | First affected pull request when a merge result is produced; `0` for ignored, unsupported, or update-only events. |

When an event resolves to multiple pull requests, the action processes them in
order and exposes the first merge result in the outputs. Update-only fan-out has
no merge result and outputs `skipped`/`0`. The full list is only in the logs.

## Behavior

### Update and merge are independent

`update-labels` and `merge-labels` are evaluated separately. A pull request can
be updated without being merged, and it can be merged without being updated.
The update decision does not depend on whether checks are running or finished.

### Updating a branch

The action updates a pull request only when it is behind its base branch:

| `mergeable_state`                       | Update behavior                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `behind`                                | Update the branch.                                                                                                                                             |
| `blocked` or `unstable`                 | Compare the head with the base; update when `behind_by > 0`. This handles the case where GitHub reports a check-related state while the branch is also behind. |
| `clean` or `has_hooks`                  | No update. This preserves the existing behavior of not updating when the repository does not require branches to be up to date.                                |
| `dirty`, `draft`, `unknown`, or missing | No update.                                                                                                                                                     |

`update-method: merge` uses the GitHub merge API to merge the base branch into
the PR head. `update-method: rebase` clones the head repository, fetches the
base, rebases, and force-pushes with `--force-with-lease`.

After an update the action refreshes the pull request. If it is not ready at
that point, the result is `not_ready`; the next Build Check completion can merge
it. There is no long retry loop waiting for checks.

### Merging

The action does not query check names. It relies on GitHub's branch protection
and the `mergeable_state` returned by the API:

| `mergeable_state`    | Meaning                                                                                       | Merge decision                                        |
| -------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `clean`              | Mergeable, required checks pass.                                                              | Merge.                                                |
| `has_hooks`          | Mergeable with passing pre-receive hooks.                                                     | Merge.                                                |
| `unstable`           | Mergeable, but non-required checks are failing. Required checks are still enforced by GitHub. | Merge.                                                |
| `blocked`            | Required review, required check, or branch protection blocks the merge.                       | `not_ready`.                                          |
| `behind`             | Head is behind the base.                                                                      | `not_ready`; update first.                            |
| `dirty`              | Merge conflict.                                                                               | `not_ready`.                                          |
| `draft`              | Draft pull request.                                                                           | `not_ready`.                                          |
| `unknown` or missing | GitHub is still calculating mergeability.                                                     | Try up to 3 times, 2 seconds apart; then `not_ready`. |
| any other value      | Unrecognized state.                                                                           | `not_ready` with a warning.                           |

`mergeable === false` and `draft === true` take precedence over the state.
`merge_failed` is emitted only when the merge API call itself fails. A merge
race is handled by re-reading the pull request; if another actor merged it, the
result is `merged`.

### Updating other pull requests after a merge

After a successful merge, the action lists up to 10 open pull requests whose
base is the same branch, excludes the merged pull request, and runs the update
path (never the merge path) for each. This keeps other behind pull requests
current and lets their own checks trigger the next run. The same update labels
and update method apply. The fan-out is bounded to avoid a CI stampede.

The bound is an internal constant; there is no `MAX_PR_COUNT` input.

### Events

Only these events are supported:

| Event                 | Source                                                                                                                   | Action                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `pull_request`        | Relevant actions: `labeled`, `unlabeled`, `synchronize`, `opened`, `edited`, `ready_for_review`, `reopened`, `unlocked`. | Update and merge the payload pull request.                                          |
| `pull_request_review` | `submitted` with `state: approved`.                                                                                      | Update and merge the reviewed pull request.                                         |
| `workflow_run`        | `completed` with `conclusion: success`, triggered by `pull_request`.                                                     | Resolve the associated pull request, or look it up by `head_sha`; update and merge. |
| `workflow_run`        | `completed` with `conclusion: success`, triggered by `push`.                                                             | List open pull requests whose base is `head_branch`; update only.                   |
| `check_suite`         | `completed` with `conclusion: success`.                                                                                  | Resolve associated pull requests or look them up by `head_sha`; update and merge.   |
| `status`              | `state: success`.                                                                                                        | Look up pull requests associated with the commit SHA; update and merge.             |
| anything else         | –                                                                                                                        | Output `skipped` and emit a warning.                                                |

GitHub does not deliver `check_suite` events for check suites created by GitHub
Actions. A Build Check implemented as a GitHub Actions workflow should be
consumed through `workflow_run`. `status` events are commit statuses, not check
runs; use `workflow_run` for Build Check.

`workflow_run` is the reliable trigger for a check that runs on both
`pull_request` and `push` to the base branch.

## Token and permissions

```yaml
permissions:
  contents: write
  pull-requests: write
```

Use `${{ secrets.GITHUB_TOKEN }}` unless you need one of the exceptions below.
The action registers the token with `core.setSecret` so the runner masks it in
logs. The token is never printed.

### `GITHUB_TOKEN` limitations

- **Merging to the base branch does not trigger `push` workflows.** GitHub
  suppresses workflow runs for events created by `GITHUB_TOKEN`. A build that
  runs on `push` to the base branch will not run after this action merges.
- **Updating a PR branch emits `pull_request synchronize`.** Build Check, which
  runs on `pull_request`, can therefore run again after an update. Since June
  2026, GitHub may create workflow runs caused by bot-created or bot-updated
  pull requests in an approval-required state, even for branches in the same
  repository. If you need unattended runs, use a GitHub App installation token
  or a personal access token, or approve the runs manually.
- **`pull_request` from a fork has a read-only token.** Write operations
  (merge/update) fail. Prefer `workflow_run`, which runs with the workflow's
  permissions, or pass a PAT/App token. Updating a fork PR branch may still fail
  because the token needs write access to the fork and the merge API update path
  targets the base repository; merging a fork PR works when branch protection
  allows it.

If you use a PAT or App token, grant only the permissions above and be aware
that merges performed with it can trigger further workflows.

## Limits and removed features

- Up to 10 pull requests are processed per list/fan-out operation.
- Branch deletion is not performed; use GitHub's automatic branch deletion or a
  separate workflow.
- Labels are not removed after merge.
- Approval counts are not read by the action; required reviews are enforced by
  GitHub branch protection.
- Base branch filters, arbitrary `PULL_REQUEST` targeting, fork blocking,
  merge-method labels, commit-message regexes/placeholders, merge/update retry
  configuration, `MERGE_ERROR_FAIL`, and custom log levels are not available.
- Unsupported events are not errors; they produce `skipped` with a warning.
- There is no local CLI or integration-test runner; use the unit tests and a
  workflow in a test repository.

## Migration from the upstream environment-variable interface

The action now reads action inputs, not `MERGE_*`/`UPDATE_*` environment
variables.

| Old                        | New                                                               |
| -------------------------- | ----------------------------------------------------------------- |
| `MERGE_LABELS`             | `merge-labels`                                                    |
| `MERGE_METHOD`             | `merge-method`                                                    |
| `MERGE_COMMIT_MESSAGE`     | `merge-commit-message` (`automatic` or `pull-request-title` only) |
| `UPDATE_LABELS`            | `update-labels`                                                   |
| `UPDATE_METHOD`            | `update-method`                                                   |
| `GITHUB_TOKEN`             | `github-token`                                                    |
| output `mergeResult`       | output `merge-result`                                             |
| output `pullRequestNumber` | output `pull-request-number`                                      |

Removed inputs: `MERGE_REMOVE_LABELS`, `MERGE_METHOD_LABELS`,
`MERGE_METHOD_LABEL_REQUIRED`, `MERGE_COMMIT_MESSAGE_REGEX`,
`MERGE_FILTER_AUTHOR`, `MERGE_FORKS`, `MERGE_REQUIRED_APPROVALS`,
`MERGE_DELETE_BRANCH`, `MERGE_DELETE_BRANCH_FILTER`, `MERGE_ERROR_FAIL`,
`MERGE_READY_STATE`, `MERGE_RETRIES`, `MERGE_RETRY_SLEEP`, `UPDATE_RETRIES`,
`UPDATE_RETRY_SLEEP`, `BASE_BRANCHES`, `PULL_REQUEST`, `MAX_PR_COUNT`, `LOG`.

Removed events: `pull_request_target`, `push`, `schedule`,
`repository_dispatch`, `issue_comment`, `workflow_dispatch`, `check_run`.
The `author_filtered` output value was removed.

## Dependency updates and releases

Dependabot is configured for weekly npm and GitHub Actions updates. The
`Dependabot auto-merge` workflow listens for a successful `CI` run on a
Dependabot pull request, verifies that the pull request still points at the SHA
that passed, and squash-merges it. CI runs format, lint, typecheck, tests, and
build. The `dist` sync gate is skipped for Dependabot pull requests because the
release pull request rebuilds `dist`.

The auto-merge workflow uses `GITHUB_TOKEN`, so it does not require the
repository auto-merge setting. It still respects branch protection: if required
checks or reviews are missing, `gh pr merge` fails instead of bypassing them.
If you use branch protection, make `CI / verify` a required check.

Releases are managed by
[googleapis/release-please-action](https://github.com/googleapis/release-please-action)
using Conventional Commits. On a push to `main`, release-please creates or
updates a release pull request. The same workflow then checks out that release
PR, formats, lints, typechecks, tests, builds `dist`, and commits `dist` (and any
formatting changes) back to the release PR. Merge the release PR to create the
tag and GitHub release.

The manifest is initialized at `1.0.0`: `fix:` produces `1.0.1`, `feat:`
produces `1.1.0`, and a breaking change produces `2.0.0`. Set an optional
`RELEASE_PLEASE_TOKEN` secret (PAT or GitHub App token) if you want CI to run on
release-please PRs and tags; otherwise the workflow falls back to
`GITHUB_TOKEN`. Pin the action to release tags rather than `@main`; `dist` on
`main` can lag between Dependabot merges and the next release.

## Development

Requires Node.js 24 and pnpm 12.

```bash
pnpm install
pnpm format        # write formatting
pnpm format:check  # verify formatting
pnpm lint
pnpm typecheck
pnpm test
pnpm build         # writes dist/index.js
pnpm verify        # all checks plus build
```

`dist/index.js` is generated by tsdown from `src/main.ts`. CI checks that the
committed bundle matches the source. Tests use a fake GitHub client and do not
need a token or a real pull request; the git rebase tests use temporary local
repositories.

## Architecture and docs

- [Architecture](docs/architecture.md)
- [Events and pull request resolution](docs/events.md)
- [Migration details](docs/migration.md)

## License

MIT. Forked from
[pascalgn/automerge-action](https://github.com/pascalgn/automerge-action);
original copyright 2019 Pascal. See [LICENSE](./LICENSE) for the full text.
