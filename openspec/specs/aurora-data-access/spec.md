# aurora-data-access Specification

## Purpose

Defines the Aurora Serverless v2 cluster and its Data API access surface that back the
`DbConfig` contract that `ingestion`'s Data API client and `infra`'s IAM policy grants
already depend on, per ADR-0003.

## Requirements

### Requirement: Aurora cluster is reachable only through RDS Data API
The Aurora Serverless v2 cluster SHALL have RDS Data API enabled, and no Lambda function
SHALL join the cluster's VPC to reach it. All application access to the cluster goes
through Data API's regional HTTPS endpoint, never a direct Postgres wire connection.

#### Scenario: Cluster has Data API enabled
- **WHEN** the Aurora cluster is provisioned
- **THEN** its Data API (`EnableHttpEndpoint`) setting is enabled

#### Scenario: No Lambda function is attached to the cluster's VPC
- **WHEN** any Lambda function in the stack is inspected for VPC configuration
- **THEN** none of them reference the Aurora cluster's VPC or subnets

### Requirement: Cluster security group grants no inbound access
The cluster's security group SHALL NOT contain an ingress rule for Lambda or any other
compute resource, since Data API does not require network-level access to the cluster.

#### Scenario: Security group has no ingress rules
- **WHEN** the cluster's security group rules are inspected
- **THEN** its ingress rule set is empty

### Requirement: Cluster engine version meets the Data API floor
The cluster's PostgreSQL engine version SHALL meet or exceed the minimum version RDS Data
API supports, confirmed against current AWS documentation at provisioning time (13.11,
14.8, or 15.3 or higher, per ADR-0003 — re-verify rather than assume this list is still
current).

#### Scenario: Engine version satisfies the documented Data API minimum
- **WHEN** the cluster's engine version is read
- **THEN** it is greater than or equal to the minimum version Data API supports for that
  major release, per current AWS documentation

### Requirement: DB credential is stored in Secrets Manager and used for Data API auth
A Secrets Manager secret SHALL hold the database credential the cluster authenticates
Data API requests with. The credential SHALL NOT be embedded in Pulumi config, environment
variables, or source in plaintext.

#### Scenario: Cluster references a Secrets Manager secret as its master credential
- **WHEN** the Aurora cluster's credential configuration is inspected
- **THEN** it references a Secrets Manager secret ARN, not an inline username/password

### Requirement: DbConfig consumers receive live resource references
`infra`'s `DbConfig` (cluster ARN, secret ARN, database name) SHALL be derived from this
change's Aurora resources' own outputs, not from manually-entered Pulumi stack config.

#### Scenario: DbConfig is sourced from the provisioned cluster
- **WHEN** `infra` resolves `DbConfig` for the ingestion pipeline and API routes
- **THEN** its `clusterArn`, `secretArn`, and `name` values trace to the Aurora cluster and
  Secrets Manager secret this change provisions, not a `pulumi.Config` read requiring
  manual entry
