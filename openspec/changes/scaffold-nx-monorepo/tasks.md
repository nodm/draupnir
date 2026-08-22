## 1. Nx Init

- [x] 1.1 Run `nx init` against the existing pnpm workspace and verify `nx.json` and
  `tsconfig.base.json` are created without altering `pnpm-lock.yaml`'s resolved versions
- [x] 1.2 Add nx-required devDependencies (`nx`, `@nx/js`, `@nx/esbuild`,
  `@nx/eslint-plugin`, `@nx/vitest`) and verify `pnpm install` completes clean

## 2. Project Stubs

- [x] 2.1 Generate `shared` lib via `nx g @nx/js:lib shared --tags=scope:shared,type:lib`
  and verify it appears in `nx show projects`
- [x] 2.2 Generate `ingestion` app via
  `nx g @nx/js:lib ingestion --tags=scope:ingestion,type:app --bundler=esbuild` and verify
  it appears in `nx show projects` tagged `scope:ingestion,type:app`
- [x] 2.3 Generate `mcp` app via
  `nx g @nx/js:lib mcp --tags=scope:mcp,type:app --bundler=esbuild` and verify it appears
  in `nx show projects` tagged `scope:mcp,type:app`
- [x] 2.4 Hand-create `infra` (directory + `project.json` tagged
  `scope:infra,type:app`, no nx generator invoked) and verify it appears in
  `nx show projects`
- [x] 2.5 Run `nx graph` and verify all four projects render with their assigned tags

## 3. Module Boundary Enforcement

- [x] 3.1 Add `@nx/enforce-module-boundaries` to the root ESLint config with the
  `depConstraints` tag matrix from design.md (infra/ingestion/mcp → shared;
  ingestion ↔ mcp forbidden; web → ingestion forbidden) and verify `nx lint shared` passes
  with the rule active
- [x] 3.2 Add a temporary disallowed import (`mcp` importing from `ingestion` internals),
  verify `nx lint mcp` fails with an `enforce-module-boundaries` violation, then remove the
  import
- [x] 3.3 Add a temporary allowed import (`ingestion` importing `shared`'s public entry
  point), verify `nx lint ingestion` passes, then remove the import

## 4. Lambda Bundling (esbuild)

- [x] 4.1 Add a trivial handler entry point to `ingestion`
  (`export const handler = async () => {}`) and configure its `build` target with
  `@nx/esbuild:esbuild`, `platform: 'node'`, `format: 'cjs'`, `external: ['@aws-sdk/*']`,
  and verify `nx build ingestion` produces a bundle
- [x] 4.2 Repeat 4.1 for `mcp` and verify `nx build mcp` produces a bundle
- [x] 4.3 Add `@types/aws-lambda` as a devDependency and type both handler stubs against
  it, verifying the build's type-check step passes
- [x] 4.4 Inspect `ingestion` and `mcp`'s build output and verify no `@aws-sdk/*` source is
  inlined (e.g. `grep -L '@aws-sdk' dist/{ingestion,mcp}/*.js` or equivalent) while the
  handler code itself is present

## 5. Infra: Hand-Written Pulumi Project

- [x] 5.1 Add `@pulumi/pulumi` and `@pulumi/aws` to `infra`'s dependencies and scaffold a
  Pulumi TypeScript program (`Pulumi.yaml`, `index.ts`) declaring zero resources — no VPC,
  subnet, NAT gateway, S3 bucket, or SQS queue
- [x] 5.2 Add a `preview` target to `infra`'s hand-written `project.json` using
  `nx:run-commands` to invoke `pulumi preview` and verify it runs successfully, with only
  Pulumi's own `pulumi:pulumi:Stack` bookkeeping resource in the plan — no AWS resource
- [x] 5.3 Add `up` and `destroy` targets to `infra`'s `project.json`, each an
  `nx:run-commands` wrapper (`pulumi up --yes`, `pulumi destroy --yes`), and verify both
  appear in `nx show project infra --json` without invoking either

## 6. Test Runner

- [x] 6.1 Register the `@nx/vitest` inferred plugin (`testTargetName: 'test'`,
  `testMode: 'run'`) in `nx.json` and add a `vitest.config.mts` to `shared`, `ingestion`,
  `mcp`, and `infra`, and verify `nx affected -t test` passes on all four with their
  (empty) stub test suites
- [x] 6.2 Add one trivial passing unit test to `shared` and verify `nx test shared` reports
  it green

## 7. Cucumber/BDD for Ingestion

- [x] 7.1 Add `@cucumber/cucumber` as a devDependency and create a `features/` directory
  under `ingestion` with one trivial passing `.feature` file
- [x] 7.2 Add a `bdd` target on `ingestion` (via `run-commands` wrapping `cucumber-js`
  scoped to `ingestion/features`) and verify `nx run ingestion:bdd` passes
- [x] 7.3 Verify no `bdd` target exists on `mcp`, `shared`, or `infra` via
  `nx show project <name> --json`

## 8. CI Pipeline

- [x] 8.1 Add `.github/workflows/ci.yml` that triggers on `pull_request` and runs, in
  order: pnpm install, `nx affected -t lint`, `nx affected -t build`,
  `nx affected -t test`, verifying each step is a separate job step that fails the run on
  non-zero exit
- [ ] 8.2 Open a trivial PR (e.g. a comment-only change to a stub file) and verify the
  workflow run completes green
- [ ] 8.3 Push the temporary disallowed import from 3.2 on a branch, verify the CI lint
  step fails, then confirm removing it restores a green run
- [x] 8.4 Verify `ci.yml` never invokes `infra`'s `preview`, `up`, or `destroy` targets —
  CI stays side-effect-free with respect to any cloud account

## 9. End-to-End Acceptance

- [x] 9.1 Run `nx graph` and verify it shows the tagged package structure matching
  proposal.md's success criteria
- [x] 9.2 Run `nx affected -t lint,test,build` from a clean checkout and verify it
  completes with no errors
- [x] 9.3 Confirm the dummy cross-boundary import (scope:web → scope:ingestion internals,
  simulated since no web project exists) fails lint per the module-boundary-enforcement
  spec's scenario
- [x] 9.4 Confirm no VPC, NAT gateway, S3 bucket, or SQS queue is declared anywhere in the
  `infra` Pulumi program, per ADR-0003 and ADR-0004
