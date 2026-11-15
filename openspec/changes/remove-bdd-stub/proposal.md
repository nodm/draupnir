## Why

The scaffold (2026-08-23) wired Cucumber into `ingestion` for BDD, but the only feature file is still the scaffold stub ("accepts no real work yet"), CI never runs it, and ingestion behaviour is covered by Vitest specs against real migrations in pglite (`processStatementFile.spec.ts` alone has 56 tests). The stub tells readers, and agents, that a BDD suite exists when it doesn't.

## What Changes

- Remove the `ingestion:bdd` target, `ingestion/features/` (one stub feature and its no-op steps) and the `@cucumber/cucumber` dev dependency.
- Remove the "Cucumber/Gherkin BDD is scoped to ingestion" requirement from `monorepo-workspace`.

**Deliberately not done:**
- Writing real feature files: the Vitest + pglite specs already describe the pipeline's behaviour; a second test style for the same code adds upkeep for two users.
- Fixing the rest of `monorepo-workspace` (it still says "exactly four projects", from before `bot`): a separate change.

Prod impact: none (test tooling only).

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `monorepo-workspace`: the BDD requirement is removed.

## Impact

- `ingestion/project.json`, `ingestion/features/`, root `package.json`, `pnpm-lock.yaml`.
