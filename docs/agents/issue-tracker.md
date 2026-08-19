# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

Repository: `Ranjan-111/boq-v1`

## Conventions

- Create issues in dependency order so blocking references exist.
- Read issue bodies, comments and labels before acting on an existing issue.
- Apply or remove labels through GitHub.
- Do not close or modify parent issues unless explicitly requested.
- Infer the repository from the Git remote when commands run inside the clone.

## Pull requests as a triage surface

PRs as a request surface: no.

GitHub shares one number space across issues and pull requests. Resolve a bare issue number before acting when its type is unclear.

## When a skill says “publish to the issue tracker”

Create a GitHub issue in `Ranjan-111/boq-v1`.

## When a skill says “fetch the relevant ticket”

Read the complete GitHub issue body, comments and labels.

## Dependencies

Prefer GitHub’s native issue dependency relationships.

Where native dependencies are unavailable, include a `Blocked by` section containing GitHub issue references. A ticket is unblocked when every referenced blocking issue is closed.

## Frontier

The frontier contains open, unassigned tickets whose blocking issues are all closed. Work blockers before dependants.
