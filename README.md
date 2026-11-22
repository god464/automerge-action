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

## Inputs

| Input                  | Required | Default     | Description                                                                                         |
| ---------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `github-token`         | yes      | –           | Token for GitHub API calls. Needs `contents: write` and `pull-requests: write`.                     |
| `merge-labels`         | no       | `automerge` | Comma-separated labels required to merge. Prefix `!` to block. Empty string means no label filter.  |
| `merge-method`         | no       | `merge`     | `merge`, `squash`, or `rebase`.                                                                     |
| `merge-commit-message` | no       | `automatic` | `automatic` or `pull-request-title`.                                                                |
| `update-labels`        | no       | `automerge` | Comma-separated labels required to update. Prefix `!` to block. Empty string means no label filter. |
| `update-method`        | no       | `merge`     | `merge` (base into PR head) or `rebase` (PR head onto base).                                        |

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
