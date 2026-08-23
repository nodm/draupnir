## Context

The repo currently has only a pnpm workspace with an OpenSpec devDependency (see
proposal.md - Why). No source packages, no build tooling, no CI exist yet. Four ADRs landed
after this change was first drafted and now fix the package shapes below: ADR-0001 (`mcp`
is a Lambda behind an API Gateway REST API, Streamable HTTP transport), ADR-0002 (Cognito
authorizer — out of scope for this scaffold), ADR-0003 (RDS Data API — no VPC-attached
Lambda, no NAT gateway), and ADR-0004 (`ingestion` is an SQS-triggered Lambda; the S3/SQS
provisioning itself is a later change's job). This design covers layering nx onto that
pnpm base without adopting nx's own package manager integration (pnpm stays authoritative),
and choosing the generators/executors for four stub projects plus a Pulumi skeleton,
Vitest, Cucumber, and a CI workflow.

## Goals / Non-Goals

**Goals:**
- Nx workspace that recognizes pnpm workspaces natively (`nx init` in "integrated" mode
  against existing `package.json`).
- One tag matrix, defined once in `nx.json`, that every current and future project is
  checked against.
- Stub projects that build/test/lint green with zero business logic, so phase-1 work adds
  code inside an already-passing pipeline rather than fixing tooling and features at once.
- `ingestion` and `mcp` scaffolded as the Lambda-handler shape their ADRs already commit
  them to (ADR-0001, ADR-0004), not a generic Node server shape that would need
  re-scaffolding later.

**Non-Goals:**
- Any `scope:web` project — the boundary rule references it so the constraint exists before
  the package does, but no UI package is scaffolded here.
- Any Pulumi resource, AWS credential, or deploy pipeline — `infra`'s Pulumi program is
  structurally present and previews clean with zero resources.
- Any VPC, subnet, or NAT gateway — ADR-0003 keeps Lambda off Aurora's VPC via RDS Data
  API; nothing in this scaffold should assume or provision VPC attachment.
- Any S3 bucket or SQS queue — ADR-0004's ingestion buckets/queue belong to the future
  statement-ingestion change, once `ingestion` exists as a place to hold that code.
- Nx Cloud / distributed caching — out of scope for a 4-project workspace; can be added
  later without touching the boundary or CI design.

## Decisions

**nx init on existing pnpm workspace, not `create-nx-workspace`.** The repo already has a
committed `package.json` and `pnpm-lock.yaml` (see recent bootstrap commit). `nx init`
adapts an existing repo in place; `create-nx-workspace` scaffolds a new one and would force
a migration. Alternative considered: start a fresh nx workspace and migrate the OpenSpec
setup into it — rejected, more disruptive for no benefit at this size.

**`@nx/js:lib` generator with `--bundler=esbuild` for `ingestion` and `mcp`, tags set
directly via `--tags=scope:*,type:app` — not `@nx/node:app`.** Both are Lambda handlers per
their ADRs (ADR-0001 for `mcp`, ADR-0004 for `ingestion`), not long-running servers.
`@nx/node:app` scaffolds a serve-oriented Node app (webpack, a `serve` target, an implicit
"this process stays up" shape) that doesn't match a Lambda handler's actual runtime
contract, and there's no first-party nx generator for "Lambda handler." `@nx/js:lib` with
the esbuild bundler produces a plain TypeScript package with an esbuild-based build target
and no server assumptions, closer to what a handler actually is; its `--tags` flag sets
`type:app` directly at generation time since these are deployable units, not shared library
code. `shared` stays on the same generator with its default `type:lib` tag. Alternative
considered: `@nx/node:app` with its `serve` target deleted post-generation — rejected,
fighting a generator's defaults after the fact is more fragile than starting from a
generator that doesn't assume a server in the first place.

**Per-function esbuild bundling with `@aws-sdk/*` external, hand-configured on top of the
generator.** Neither `@nx/js:lib --bundler=esbuild` nor `@nx/node:app` produces a
Lambda-shaped bundle out of the box — the generator's esbuild option handles "bundle this
package," not "bundle this specific handler entry point, targeting the Node.js Lambda
runtime, excluding the SDK the runtime already provides." Each handler entry point gets its
own `@nx/esbuild:esbuild` target invocation with `platform: 'node'`, `format: 'cjs'`, and
`external: ['@aws-sdk/*']`. Externalizing `@aws-sdk/*` is standard Lambda Node.js practice —
the managed runtime provides AWS SDK v3, so bundling it in only grows the deployment package
for no benefit; confirm the exact SDK version the target Lambda runtime preinstalls against
current AWS docs when the real handler code is written, not from this design doc's memory.

**Tag matrix expressed as `depConstraints` in a single root ESLint config.**
`@nx/enforce-module-boundaries` reads `sourceTag` → allowed `onlyDependOnLibsWithTags` per
project. One matrix, defined once, keeps the phase-1 auth/transaction-store/ingestion/MCP
work from each inventing its own boundary rule. The matrix for this change:
- `scope:infra` → may depend on `scope:shared`
- `scope:ingestion` → may depend on `scope:shared`
- `scope:mcp` → may depend on `scope:shared`
- `scope:ingestion` and `scope:mcp` → explicitly forbidden from depending on each other
- `scope:web` (not yet created) → forbidden from depending on `scope:ingestion`

The matrix is keyed on `scope:*` tags only — `ingestion` and `mcp` moving from `type:lib` to
`type:app` doesn't touch it. Alternative considered: per-project eslintrc overrides —
rejected, harder to see the whole matrix at a glance and easier to drift as projects are
added.

**Vitest via the `@nx/vitest` inferred plugin, not Jest, and not `@nx/vite:test`.** At the
installed nx version, Vitest integration ships as its own `@nx/vitest` package (separate
from `@nx/vite`, which only has `dev-server`/`build`/`preview-server` executors — no `test`
executor exists there). `@nx/vitest` is registered once in `nx.json`'s `plugins` array
(`testTargetName: 'test'`, `testMode: 'run'`) and auto-creates a `test` target for any
project with a `vitest.config.mts`, the same inferred-task pattern already used for
`@nx/eslint/plugin`. `testMode: 'run'` is a deliberate override of the plugin's own
default (`'watch'`) — left on `'watch'`, `nx test <project>` runs bare `vitest` in
interactive watch mode, which never exits and would hang `nx affected -t test` in CI.
Vitest itself is faster than Jest and shares config shape with the Vite ecosystem tooling
likely to be used for any future `scope:web` project, keeping one test-runner mental model
workspace-wide. No existing Jest config to migrate away from, beyond what `@nx/js:lib`
itself defaults to generating (removed as part of this change).

**Cucumber wired as a custom nx target on `ingestion` only, not a shared executor.**
Nx has no official Cucumber executor; a thin custom target (`nx run ingestion:bdd` →
`cucumber-js`) scoped to that one project's `features/` directory is simpler than building
a reusable executor for a BDD need that, per the proposal, is intentionally
pipeline-specific rather than workspace-wide.

**`infra`'s `project.json` is hand-written, not generated — no nx generator scaffolds it,
and no official `@nx/pulumi` plugin exists.** `infra/` is created directly at the repo root
(directory + `project.json` + `Pulumi.yaml`/`index.ts`), tagged `scope:infra,type:app`,
matching the flat layout `@nx/js:lib` already produced for the other three projects (this
nx version places generated projects at the repo root, not under `apps/`/`libs/`), with
three
`nx:run-commands` targets shelling out to the Pulumi CLI: `preview` (`pulumi preview`), `up`
(`pulumi up --yes`), and `destroy` (`pulumi destroy --yes`). Only `preview` is ever invoked
by this change or by CI — `up`/`destroy` are wired so `infra` has a consistent target
surface for future changes that actually provision resources, not because this change runs
them. The Pulumi program itself declares zero resources: no VPC/subnet/NAT gateway
(ADR-0003 keeps Lambda off Aurora's VPC entirely), no S3 bucket or SQS queue (ADR-0004's
ingestion storage/queue is the statement-ingestion change's job, not this scaffold's).

**`infra`'s `build` target is a type-check (`tsc --noEmit`), not a compile-to-`dist`
step.** Pulumi's `nodejs` runtime reads `index.ts` directly via its own `ts-node`
integration (driven by `Pulumi.yaml` + `infra/tsconfig.json`) — nothing ever consumes a
compiled `dist/infra` output the way `ingestion`/`mcp`'s esbuild bundles or `shared`'s
`@nx/js:tsc` output are consumed. A `tsc --noEmit` `run-commands` target gets `infra`
covered by `nx affected -t build` (so a broken Pulumi program fails CI, not just `preview`)
without producing an output nothing reads. `infra/tsconfig.json`'s `moduleResolution` is
`node16`, not the legacy `node`/`node10` value — that option is deprecated as of TypeScript
6 and errors under `--noEmit` (`tsc --noEmit` surfaced this; `pulumi preview`'s own
`ts-node` path hadn't).

## Risks / Trade-offs

- [Tag matrix defined once in `nx.json` but not yet exercised by real cross-package
  imports] → Mitigation: the spec's dummy cross-boundary import scenario (module-boundary-
  enforcement) is exercised manually as part of this change's acceptance, not left
  theoretical.
- [Cucumber has no first-party nx executor, so the `bdd` target is a hand-rolled
  `run-commands` wrapper] → Mitigation: keep it a thin passthrough to `cucumber-js`; if nx
  ships an official executor later, swapping it in is a one-target change.
- [Vitest choice diverges from nx's more common Jest default in older docs/examples] →
  Mitigation: document the choice here so future contributors don't "fix" it back to Jest.
- [`@nx/js:lib --bundler=esbuild` plus a `type:app` tag applied via `--tags` is a generator
  used slightly against its default grain] → Mitigation: document the override here so a
  future contributor doesn't "fix" the tag back to `type:lib` assuming it's drift.
- [`infra`'s `up`/`destroy` targets exist from this change onward but are never exercised by
  it or by CI] → Mitigation: keep them as thin one-line `run-commands` wrappers so there's
  nothing to get wrong before they're actually used; the risk is dead code, not a
  behavioral bug.
- [Vitest exits non-zero on zero matched test files by default, unlike the "zero tests is
  an acceptable pass" scaffold requirement] → Mitigation: `infra` (the one project with no
  spec files yet) sets `test.passWithNoTests: true` in its `vitest.config.mts`; any future
  project generated empty needs the same flag until it gains a real test.

## Open Questions
(none — all decisions above are settled for this change; phase-1 packages may revisit the
tag matrix as `scope:web` or new scopes are actually introduced, but that's a future
change's concern, not this one's)
