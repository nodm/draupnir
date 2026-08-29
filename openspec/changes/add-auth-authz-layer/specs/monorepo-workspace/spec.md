## MODIFIED Requirements

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

## ADDED Requirements

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
