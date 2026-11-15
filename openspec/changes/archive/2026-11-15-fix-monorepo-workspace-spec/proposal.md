## Why

`monorepo-workspace` still describes the 2026-08 scaffold: four projects (no `bot`), an infra "skeleton" whose scenarios expect no VPC, S3 or SQS and mention the ingestion REST API removed in `remove-ingestion-api`, and esbuild bundling for `ingestion` and `mcp` only. Agents and `/opsx` workflows read the main specs as current truth, so a spec that contradicts the code leads them astray.

## What Changes

Spec-only; the code already behaves this way.

- Workspace: five tagged projects, adding `bot` (`scope:bot,type:app`).
- Infra: the principle stays (declare only what a landed change needs, `preview` succeeds); the two scaffold-era scenarios are replaced by one about the current stack.
- Bundling: `bot`, `ingestion` and `mcp` bundle with esbuild, `@aws-sdk/*` external (and `@modelcontextprotocol/*` for `mcp`).
- Vitest: the scenario lists all five projects.
- Purpose line updated to the current layout (applied when archiving).

**Deliberately not done:**
- Listing every infra resource in the spec: `docs/architecture.md` holds that and changes with each infra change.
- Specifying the `typecheck` and `parallelism: false` details here: `ci-pipeline` covers the gate, and test scheduling is tooling, not behaviour.

Prod impact: none.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `monorepo-workspace`: project list, infra resource rule, esbuild bundling and Vitest scenarios brought up to date.

## Impact

- `openspec/specs/monorepo-workspace/spec.md` only.
