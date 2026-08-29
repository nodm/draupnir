# monorepo-workspace Specification

## Purpose

Provides the tagged nx workspace layout — ingestion, mcp, shared, and infra projects, a
Pulumi skeleton, and a base test runner — that all phase-1 packages are built inside.

## Requirements

### Requirement: Workspace exposes four tagged projects
The workspace SHALL contain exactly four nx projects: `ingestion` (tagged
`scope:ingestion,type:app`), `mcp` (tagged `scope:mcp,type:app`), `shared` (tagged
`scope:shared,type:lib`), and `infra` (tagged `scope:infra,type:app`).

#### Scenario: Graph reflects the tagged structure
- **WHEN** a developer runs `nx graph`
- **THEN** the graph shows exactly the `ingestion`, `mcp`, `shared`, and `infra` projects,
  each carrying its declared tags

#### Scenario: Affected commands run cleanly on the stubs
- **WHEN** a developer runs `nx affected -t lint,test,build` with no source changes beyond
  the generated stubs
- **THEN** all four projects pass lint, test, and build with no errors

### Requirement: Infra project contains a resource-free Pulumi skeleton until a change needs resources

The `infra` app's Pulumi program SHALL declare only the cloud resources that a
landed change actually needs — no speculative or unused resources — and SHALL
continue to run `pulumi preview` successfully against the `prod` stack once
resources exist.

#### Scenario: Preview succeeds with no resources before any change needs one

- **WHEN** a developer runs `pulumi preview` against the `infra` project's stack
  before any change has provisioned a resource
- **THEN** the command completes successfully, and the only resource in the plan
  is Pulumi's own stack bookkeeping object (`pulumi:pulumi:Stack`) — no AWS/cloud
  resource appears

#### Scenario: Preview reflects only resources landed changes have added

- **WHEN** a developer runs `pulumi preview` against the `infra` project's `prod`
  stack after a change has provisioned resources (for example, the Cognito User
  Pool and `ingestion` API Gateway REST API from `add-auth-authz-layer`)
- **THEN** the command completes successfully, and the plan matches exactly the
  resources that landed changes declared — no VPC, NAT gateway, S3 bucket, or SQS
  queue until a change that specifically needs one lands (per ADR-0003/ADR-0004)

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

### Requirement: Ingestion and mcp bundle with esbuild, aws-sdk external
The `ingestion` and `mcp` build targets SHALL bundle each Lambda handler entry point with
esbuild, targeting the Node.js platform, and SHALL exclude `@aws-sdk/*` packages from the
bundle (marked external).

#### Scenario: Build output excludes aws-sdk
- **WHEN** a developer runs `nx build ingestion` (or `nx build mcp`)
- **THEN** the resulting bundle contains the handler code but does not inline any
  `@aws-sdk/*` package source

### Requirement: Vitest is the base test runner for every project
Every generated project SHALL run its unit tests through Vitest via its nx `test` target.

#### Scenario: Test target invokes Vitest
- **WHEN** a developer runs `nx test <project>` for any of `ingestion`, `mcp`, `shared`, or
  `infra`
- **THEN** Vitest executes and reports a pass (zero tests is an acceptable pass for the
  empty stub)

### Requirement: Cucumber/Gherkin BDD is scoped to ingestion
`.feature` files under Cucumber SHALL execute only against projects tagged
`scope:ingestion`; running the BDD target against a non-ingestion project SHALL be a no-op
or unavailable target, not a failure.

#### Scenario: BDD target exists for ingestion
- **WHEN** a developer runs the ingestion project's `bdd` (or equivalent Cucumber) target
- **THEN** Cucumber executes against `.feature` files scoped to that project and reports a
  pass

#### Scenario: BDD target is absent elsewhere
- **WHEN** a developer inspects the `mcp`, `shared`, or `infra` project's targets
- **THEN** no Cucumber/BDD target is configured for those projects
