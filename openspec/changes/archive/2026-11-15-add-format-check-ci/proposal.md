## Why

`prettier --check .` failed on 190 files and nothing in CI checked formatting, so anyone (or any agent) running `prettier --write` produced large diffs unrelated to their change.

## What Changes

- `.prettierignore` skips `openspec/` (read by the OpenSpec CLI), tool-generated skill and command files, `pnpm-lock.yaml` and the local `-temp-/` folder.
- The remaining files are formatted once (formatting only).
- CI checks the formatting of the whole repository before lint; an unformatted file fails the run.
- `AGENTS.md` lists the format command.

**Deliberately not done:**
- Formatting `openspec/`: reflowing could change how the CLI parses headers and scenarios, and archived changes are history.
- A pre-commit hook: CI is the gate; a hook can be added later without changing the spec.

Prod impact: none (no deployed code changes).

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `ci-pipeline`: the PR gate adds a formatting check before lint.

## Impact

- `.prettierignore`, `.github/workflows/ci.yml`, `AGENTS.md`; 13 files reformatted (`bot/src/lib/webhook.ts`, 8 docs, 3 specs/sources, `.vscode/settings.json`).
