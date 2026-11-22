# automerge-action

A GitHub Action to automatically update and merge pull requests based on configurable labels and GitHub's merge readiness.

- **Update:** Bring PR branches up to date with the base branch using merge or rebase.
- **Merge:** Automatically merge PRs when GitHub reports them as ready.

Forked from [pascalgn/automerge-action](https://github.com/pascalgn/automerge-action) (MIT), with a decision-function-based implementation and input-based configuration.

## Usage

Create `.github/workflows/automerge.yml`:

```yaml
name: automerge

on:
  pull_request:
    types: [labeled, unlabeled, synchronize, opened, edited, ready_for_review, reopened, unlocked]
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

      - name: Feedback
        if: steps.automerge.outputs.merge-result == 'merged'
        run: echo "Merged PR #${{ steps.automerge.outputs.pull-request-number }}"
```

## Inputs

| Input                  | Default     | Description                                                                    |
| ---------------------- | ----------- | ------------------------------------------------------------------------------ |
| `github-token`         | Required    | Token with `contents: write` and `pull-requests: write` permissions.           |
| `merge-labels`         | `automerge` | Labels required for merging. Prefix `!` to exclude. Empty disables filtering.  |
| `merge-method`         | `merge`     | Merge method: `merge`, `squash`, or `rebase`.                                  |
| `merge-commit-message` | `automatic` | Commit message: `automatic` or `pull-request-title`.                           |
| `update-labels`        | `automerge` | Labels required for updating. Prefix `!` to exclude. Empty disables filtering. |
| `update-method`        | `merge`     | Update method: `merge` (base into PR) or `rebase` (PR onto base).              |

## Outputs

| Output                | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `merge-result`        | `skipped`, `not_ready`, `merge_failed`, or `merged`. |
| `pull-request-number` | PR number, or `0` if none.                           |

## Permissions & Tokens

The action requires:

```yaml
permissions:
  contents: write
  pull-requests: write
```

Use `GITHUB_TOKEN` by default. Consider a GitHub App or PAT when:

- You need merges to trigger downstream `push` workflows.
- Bot-created workflow runs require approval.
- You need write access for pull requests from forks.

**Security note:** `pull_request_target` provides write permissions in the base repository context. Never check out or execute untrusted pull request code in this workflow.
