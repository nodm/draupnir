## RENAMED Requirements

- FROM: `### Requirement: Workspace exposes four tagged projects`
- TO: `### Requirement: Workspace exposes five tagged projects`

- FROM: `### Requirement: Ingestion and mcp bundle with esbuild, aws-sdk external`
- TO: `### Requirement: Lambda apps bundle with esbuild, aws-sdk external`

## REMOVED Requirements

### Requirement: Infra project contains a resource-free Pulumi skeleton until a change needs resources
**Reason**: Its scenarios describe the scaffold: an empty stack, no VPC, S3 bucket or SQS queue, and the ingestion REST API that `remove-ingestion-api` deleted. All of those have since changed.
**Migration**: Replaced by "Infra declares only the resources landed changes need", which keeps the rule (no speculative resources, `preview` succeeds) without the scaffold-era scenarios.

## ADDED Requirements

### Requirement: Infra declares only the resources landed changes need
The `infra` app's Pulumi program SHALL declare only the cloud resources that a landed change
needs — no speculative or unused resources — and `pulumi preview` against the `prod` stack
SHALL succeed.

#### Scenario: Preview matches landed changes
- **WHEN** a developer runs `nx run infra:preview` against the `prod` stack on an up-to-date
  `main`
- **THEN** the command completes successfully and proposes no creates, replaces or deletes
  for resources that no landed change declared

## MODIFIED Requirements

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
