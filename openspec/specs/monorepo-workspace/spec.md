# monorepo-workspace Specification

## Purpose

Provides the tagged nx workspace layout — `ingestion`, `bot`, `mcp`, `shared` and `infra`
projects, esbuild-bundled Lambda apps, a Pulumi program that declares only what landed changes
need, and Vitest as the test runner — that every package is built inside.

## Requirements

### Requirement: Workspace exposes five tagged projects
The workspace SHALL contain exactly five nx projects: `ingestion` (tagged
`scope:ingestion,type:app`), `bot` (tagged `scope:bot,type:app`), `mcp` (tagged
`scope:mcp,type:app`), `shared` (tagged `scope:shared,type:lib`), and `infra` (tagged
`scope:infra,type:app`).

#### Scenario: Graph reflects the tagged structure
- **WHEN** a developer runs `nx show projects` (or `nx graph`)
- **THEN** it lists exactly the `ingestion`, `bot`, `mcp`, `shared`, and `infra` projects,
  each carrying its declared tags

#### Scenario: Affected commands run cleanly on the stubs
- **WHEN** a developer runs `nx affected -t lint,test,build` on a clean checkout of `main`
- **THEN** all affected projects pass lint, test, and build with no errors

### Requirement: Infra declares only the resources landed changes need
The `infra` app's Pulumi program SHALL declare only the cloud resources that a landed change
needs — no speculative or unused resources — and `pulumi preview` against the `prod` stack
SHALL succeed.

#### Scenario: Preview matches landed changes
- **WHEN** a developer runs `nx run infra:preview` against the `prod` stack on an up-to-date
  `main`
- **THEN** the command completes successfully and proposes no creates, replaces or deletes
  for resources that no landed change declared

### Requirement: Every provisioned resource carries stack-derived default tags

Once `infra` provisions any AWS resource, its Pulumi program SHALL apply
`Project`, `ManagedBy`, and `Environment` tags to every taggable resource via
a single explicit `aws.Provider`, with `Environment` set to the active
Pulumi stack name (`pulumi.getStack()`) rather than a value manually typed
per stack.

#### Scenario: Tags reflect the stack being deployed

- **WHEN** a developer runs `pulumi preview`/`pulumi up` against a given
  stack (for example `prod`)
- **THEN** every taggable resource in the plan carries `Project: draupnir`,
  `ManagedBy: pulumi`, and `Environment: <that stack's name>`, with no
  manual per-stack tag configuration required

### Requirement: Infra exposes preview, up, and destroy Pulumi targets
The `infra` project's hand-written configuration SHALL expose three nx targets —
`preview`, `up`, and `destroy` — each an `nx:run-commands` target wrapping the equivalent
Pulumi CLI command against the project's stack.

#### Scenario: All three targets are defined
- **WHEN** a developer runs `nx show project infra --json`
- **THEN** `preview`, `up`, and `destroy` targets are present, invoking `pulumi preview`,
  `pulumi up`, and `pulumi destroy` respectively

#### Scenario: CI never invokes up or destroy
- **WHEN** the GitHub Actions workflow runs on a pull request
- **THEN** it does not invoke `infra`'s `up` or `destroy` targets

### Requirement: Lambda apps bundle with esbuild, aws-sdk external
The `bot`, `ingestion` and `mcp` build targets SHALL bundle each Lambda handler entry point
with esbuild, targeting the Node.js platform, and SHALL exclude `@aws-sdk/*` packages from
the bundle (marked external). The `mcp` build SHALL also mark `@modelcontextprotocol/*`
external; those packages are installed next to the bundle instead.

#### Scenario: Build output excludes aws-sdk
- **WHEN** a developer runs `nx build ingestion` (or `nx build bot`, `nx build mcp`)
- **THEN** the resulting bundle contains the handler code but does not inline any
  `@aws-sdk/*` package source

### Requirement: Vitest is the base test runner for every project
Every project SHALL run its unit tests through Vitest via its nx `test` target.

#### Scenario: Test target invokes Vitest
- **WHEN** a developer runs `nx test <project>` for any of `ingestion`, `bot`, `mcp`,
  `shared`, or `infra`
- **THEN** Vitest executes and reports a pass
