## Why

Draupnir's phase-1 work (auth, transaction-store, ingestion, MCP server) needs a workspace
that already separates concerns and stops cross-boundary imports before they're written.
Laying the nx structure and boundary rules down first — before any of those packages have
real code — means every phase-1 change lands inside guardrails instead of retrofitting them
later.

## What Changes

- Run `nx init` on top of the existing pnpm workspace (no package manager change).
- Generate four tagged projects as empty stubs:
  - `ingestion` app — `scope:ingestion,type:app` — an SQS-triggered Lambda handler
    (ADR-0004's shape), not a generic Node server.
  - `mcp` app — `scope:mcp,type:app` — a Lambda handler behind an API Gateway REST API
    (ADR-0001), not a generic Node server.
  - `shared` lib — `scope:shared,type:lib`
  - `infra` app — `scope:infra,type:app` — a hand-written Pulumi TypeScript project (no nx
    generator scaffolds it; no official `@nx/pulumi` plugin exists).
- Configure `@nx/enforce-module-boundaries` with a tag matrix that allows `infra` to depend
  on `shared`, allows `ingestion`/`mcp` to depend on `shared`, and blocks `ingestion` ↔ `mcp`
  cross-imports and any `scope:web` → `scope:ingestion` internal import (no `web` project
  exists yet in phase 1 — the rule is defined so the boundary is enforced the moment one
  lands).
- Configure per-function esbuild bundling for `ingestion` and `mcp`, with `@aws-sdk/*`
  marked external (present in the Lambda Node.js runtime already) — neither stock nx
  generator produces this, it's hand-configured on top.
- Hand-write `infra`'s `project.json` with `nx:run-commands` targets wrapping the Pulumi
  CLI: `preview`, `up`, `destroy`. The Pulumi program itself declares zero resources — no
  VPC, no NAT gateway (ADR-0003 keeps Lambda off any VPC via RDS Data API), no S3/SQS
  (ADR-0004's ingestion buckets/queue are provisioned in the future statement-ingestion
  change, not here).
- Configure Vitest as the base test runner for all projects.
- Wire Cucumber/Gherkin for BDD, scoped so `.feature` specs only run against
  `scope:ingestion`-tagged projects.
- Add a GitHub Actions workflow that runs install → lint → build → test on every PR (never
  `preview`/`up`/`destroy` — CI stays side-effect-free with respect to any cloud account).

## Capabilities

### New Capabilities
- `monorepo-workspace`: nx workspace bootstrapped on the existing pnpm repo, with `ingestion`
  and `mcp` scaffolded as Lambda-handler apps (esbuild-bundled, `@aws-sdk/*` external),
  `shared` as a lib, `infra` as a hand-written Pulumi TS project with `preview`/`up`/`destroy`
  targets, Vitest as the base runner, and Cucumber/Gherkin wired to run only against
  `scope:ingestion` projects.
- `module-boundary-enforcement`: `@nx/enforce-module-boundaries` lint rule configured from a
  tag matrix, so a disallowed cross-scope import fails lint.
- `ci-pipeline`: GitHub Actions workflow that runs install, lint, build, and test on every
  pull request.

### Modified Capabilities
(none — greenfield workspace, nothing existing changes behavior)

## Impact

- **Affected code**: repo root (`nx.json`, `package.json`, `tsconfig.base.json`,
  `pnpm-workspace.yaml`), new `ingestion/`, `mcp/`, `shared/`, `infra/` project directories
  at the repo root (nx's current default flat layout — no `apps/`/`libs/` prefix),
  `.github/workflows/`.
- **Dependencies added**: `nx`, `@nx/js`, `@nx/esbuild`, `@nx/eslint-plugin` (for
  `enforce-module-boundaries`), `vitest`, `@nx/vitest` (Vitest inferred-plugin integration),
  `@cucumber/cucumber`, `@pulumi/pulumi` + `@pulumi/aws`, `@types/aws-lambda`.
- **Out of scope**: no AWS resources provisioned (no VPC, no NAT gateway per ADR-0003; no
  S3/SQS per ADR-0004 — both deferred to the change that actually needs them), no auth/data
  model, no UI/`scope:web` packages (the boundary rule references `scope:web` preemptively
  but no such project is created in this change).
- **CI**: new workflow triggers on PR; runs lint/build/test only, never touches Pulumi's
  `up`/`destroy`; no existing workflows to migrate.
