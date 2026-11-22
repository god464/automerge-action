# automerge-action

GitHub Action that updates pull request branches that are behind their base
branch and merges pull requests GitHub reports as ready when the configured
labels match.

This is a fork of
[pascalgn/automerge-action](https://github.com/pascalgn/automerge-action)
(MIT), rewritten around pure decision functions. Configuration is passed through
action `inputs`.

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
    types: [submitted]
  workflow_run:
    workflows: [Build Check]
    types: [completed]

permissions:
  contents: write
  pull-requests: write

jobs:
  automerge:
    if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - id: automerge
        uses: god464/automerge-action@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          merge-labels: automerge
          merge-method: squash
          update-labels: automerge
          update-method: merge

      - name: feedback
        if: steps.automerge.outputs.merge-result == 'merged'
        run: echo "Merged pull request #${{ steps.automerge.outputs.pull-request-number }}"
```

Pin `uses:` to a release tag or commit SHA for production use.

## Inputs

| Input                  | Required | Default     | Description                                                                                         |
| ---------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `github-token`         | yes      | –           | Token for GitHub API calls. Needs `contents: write` and `pull-requests: write`.                     |
| `merge-labels`         | no       | `automerge` | Comma-separated labels required to merge. Prefix `!` to block. Empty string means no label filter.  |
| `merge-method`         | no       | `merge`     | `merge`, `squash`, or `rebase`.                                                                     |
| `merge-commit-message` | no       | `automatic` | `automatic` or `pull-request-title`.                                                                |
| `update-labels`        | no       | `automerge` | Comma-separated labels required to update. Prefix `!` to block. Empty string means no label filter. |
| `update-method`        | no       | `merge`     | `merge` (base into PR head) or `rebase` (PR head onto base).                                        |

Label matching is exact and case-sensitive. If a label is both required and
blocking (`!`), blocking wins and a warning is emitted. Empty entries are
ignored. Label names containing commas cannot be expressed.

`merge-method` and `update-method` are independent: for example, update with a
merge commit and squash-merge the pull request.

## Outputs

| Output                | Values                                           | Description                                                                       |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `merge-result`        | `skipped`, `not_ready`, `merge_failed`, `merged` | Merge decision or merge API result.                                               |
| `pull-request-number` | number, or `0`                                   | First affected pull request; `0` for ignored, unsupported, or update-only events. |

When an event resolves to multiple pull requests, they are processed in order
and the first merge result is exposed. Each pull request is logged as it is
processed.

## Behavior

Update and merge decisions are independent: a pull request can be updated
without being merged, and merged without being updated.

### Updating

| `mergeable_state`                       | Behavior                                            |
| --------------------------------------- | --------------------------------------------------- |
| `behind`                                | Update.                                             |
| `blocked` or `unstable`                 | Compare head and base; update when `behind_by > 0`. |
| `clean` or `has_hooks`                  | No update.                                          |
| `dirty`, `draft`, `unknown`, or missing | No update.                                          |

With `update-method: merge` the action merges the base branch into the pull
request head through the API. Fork pull requests use GitHub's pull request
branch update endpoint with the expected head SHA, so a same-named branch in
the base repository is never touched. With `rebase` it clones the head
repository, fetches the base branch from the base repository, rebases, and
force-pushes with `--force-with-lease` pinned to the snapshot head SHA.

Compare requests are fail-closed when the update decision requires one: if
GitHub's compare API fails, returns an invalid response, or the result cannot
be interpreted, the pull request is not updated and the merge is refused for
that run. The probe is part of the update decision; if `update-labels` do not
match, no compare is made and the merge decision uses GitHub's mergeable state.

Update-only runs fetch mergeability once and retry once after 1 second. If it
is still unknown and cannot be probed with compare, the pull request is skipped
with a warning; a later event may retry.

After an update the pull request is refreshed. If it is not ready then, the
result is `not_ready`; the next check completion can merge it. A refresh that
returns `behind`, remains `unknown`, or fails also produces `not_ready`. Only a
refreshed snapshot that GitHub reports as mergeable may continue to merge.

### Merging

| `mergeable_state`    | Behavior                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| `clean`              | Merge.                                                                      |
| `has_hooks`          | Merge.                                                                      |
| `unstable`           | Merge. Required checks still pass; non-required checks may fail.            |
| `blocked`            | `not_ready`. Required review, check, or branch protection blocks the merge. |
| `behind`             | `not_ready`. Update first.                                                  |
| `dirty`              | `not_ready`. Merge conflict.                                                |
| `draft`              | `not_ready`.                                                                |
| `unknown` or missing | Up to 3 attempts (2 retries), 2 seconds apart, then `not_ready`.            |
| any other value      | `not_ready` with a warning.                                                 |

`mergeable === false` and `draft === true` take precedence over the state. A
merge also requires `mergeable === true`: when GitHub returns `mergeable: null`,
ready-looking states such as `clean` and `unstable` are treated as unknown and
retried; states that are already definitively not ready stay not ready.

`unstable` is probed with the compare API before merging when the pull request
is eligible for update. A failed compare is not treated as up to date and
produces `not_ready`; when the comparison shows the branch is behind, the
action updates it first and then uses the refreshed state. If `update-labels`
exclude the pull request, no probe is made and the merge decision uses GitHub's
`mergeable_state`.

`merge_failed` is emitted when the merge API call fails or returns
`merged: false`. A merge race is handled by re-reading the pull request; if
another actor merged it, the result is `merged`.

After a successful merge, the action lists up to 10 open pull requests based on
the same base branch, excludes the merged pull request, and runs update-only for
each. The bound is an internal constant.

### Events

| Event                          | Accepted                                                                                              | Target                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pull_request`                 | `labeled`, `unlabeled`, `synchronize`, `opened`, `edited`, `ready_for_review`, `reopened`, `unlocked` | Payload pull request; update and merge.                         |
| `pull_request_target`          | same as `pull_request`                                                                                | Payload pull request; update and merge.                         |
| `pull_request_review`          | `submitted` with `review.state = approved`                                                            | Reviewed pull request; update and merge.                        |
| `workflow_run`                 | `completed` + `conclusion = success`; triggered by `pull_request`                                     | Associated pull requests, or commit SHA; update and merge.      |
| `workflow_run`                 | `completed` + `conclusion = success`; triggered by `push`                                             | Open pull requests whose base is `head_branch`; update only.    |
| `check_suite`                  | `completed` + `conclusion = success`                                                                  | Associated pull requests, or commit SHA; update and merge.      |
| `status`                       | `state = success`                                                                                     | Pull requests associated with the commit SHA; update and merge. |
| `workflow_run` / `check_suite` | not `completed`, or `completed` with `conclusion != success`                                          | Output `not_ready`.                                             |
| anything else                  | –                                                                                                     | Output `skipped` and emit a warning.                            |

`workflow_run` and `check_suite` payloads must contain a valid `pull_requests`
array. A missing, non-array, or partially malformed list is reported as a
malformed payload and never falls back to the commit SHA.

GitHub does not deliver `check_suite` events for check suites created by GitHub
Actions. Use `workflow_run` for a Build Check implemented as an Actions
workflow. `status` events are commit statuses, not check runs.

## Token and permissions

```yaml
permissions:
  contents: write
  pull-requests: write
```

Use `${{ secrets.GITHUB_TOKEN }}` unless one of these applies:

- Merging with `GITHUB_TOKEN` does not trigger `push` workflows on the base
  branch.
- Bot-updated pull requests may produce workflow runs in an approval-required
  state. Use a GitHub App/PAT token for unattended CI, or approve runs manually.
- A `pull_request` event from a fork has a read-only token. Prefer
  `workflow_run`, `pull_request_target`, or a PAT/App token.
- `pull_request_target` runs in the base repository context with a
  write-capable token. Do not check out untrusted pull request code in a
  `pull_request_target` workflow.

The token is passed to git through a per-process HTTP authorization header. It
is not embedded in clone URLs or command arguments.

## Limits

- Up to 10 pull requests per list/fan-out operation.
- A rebase run (clone, fetch/deepen, rebase, push) shares one 5-minute deadline;
  each git command receives only the remaining budget.
- Branches are not deleted and labels are not removed after merge.
- Approval counts are not read; required reviews are enforced by branch
  protection.
- Unsupported events are not errors; they produce `skipped` with a warning.

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

`dist/index.js` is generated by tsdown from `src/main.ts`; CI checks that the
committed bundle matches the source. Tests use a fake GitHub client and need no
token; git rebase tests use temporary local repositories.

## License

MIT. Forked from
[pascalgn/automerge-action](https://github.com/pascalgn/automerge-action);
original copyright 2019 Pascal. See [LICENSE](./LICENSE) for the full text.
