## 1. Networking shell

- [x] 1.1 In `infra/lib/aurora.ts`, add a VPC with two private subnets across two AZs and a DB subnet group spanning them (no NAT Gateway, no internet gateway); verify `nx run infra:build` succeeds and the subnet group references both subnets.
- [x] 1.2 Add a security group for the cluster with zero ingress rules; verify `nx run infra:build` succeeds and no ingress rule is defined on the resource.

## 2. Aurora Serverless v2 cluster

- [x] 2.1 Add the `aws.rds.Cluster` (`engine: "aurora-postgresql"`, `engineMode: "provisioned"`, a current LTS engine version confirmed ≥ 13.11/14.8/15.3 via `aws rds describe-db-engine-versions --engine aurora-postgresql`, `enableHttpEndpoint: true`, `manageMasterUserPassword: true` (AWS-owned Secrets Manager secret — no `masterPassword` set), `serverlessv2ScalingConfiguration` at the low end of the ACU range per design.md, the subnet group and security group from section 1) and its `aws.rds.ClusterInstance` (`instanceClass: "db.serverless"`); verify `nx run infra:build` succeeds.
- [x] 2.2 Export `createAuroraCluster(provider): AuroraCluster` from `infra/lib/aurora.ts`, returning `dbConfig: DbConfig` (matching the existing shape in `infra/lib/ingestionPipeline.ts`) built from the cluster's ARN, `cluster.masterUserSecrets[0].secretArn`, and the database name, plus the underlying `vpc`/`cluster` resources; verify `nx run infra:build` succeeds.

## 3. Wire into the stack

- [x] 3.1 Remove `loadDbConfig()` from `infra/lib/ingestionPipeline.ts` (keep the `DbConfig` type — `dataApiPolicyStatements()` still consumes it); verify `nx run infra:build` succeeds with no remaining references to the removed function.
- [x] 3.2 In `infra/index.ts`, call `createAuroraCluster(provider)` before `createIngestionPipeline`/`createIngestionApi` and pass its `dbConfig` through in place of the removed `loadDbConfig()` call; verify `nx run infra:build` succeeds and `pnpm nx run-many -t lint test build --projects=infra` passes.

## 4. Verification

- [x] 4.1 Once deployed with real AWS credentials, run `pulumi preview`/`pulumi up` against a test/dev stack and confirm the cluster reaches `available` with Data API enabled and the security group has no ingress rules. A freshly created cluster has no application tables — this change is schema/data-migration-agnostic by design (see proposal.md's Out of scope), so before testing any endpoint, manually run `ACCOUNTS_TABLE_DDL` and `TRANSACTIONS_TABLE_DDL` (`shared/src/lib/transactionsSchema.ts`) once against the live cluster via `rds-data execute-statement` (or the AWS Console's Data API query editor), using the deployed `dbConfig`'s cluster/secret ARNs. Only then confirm `import-bank-statements`'s `POST /accounts` and presigned-upload endpoints succeed against the live `DbConfig` (unblocking that change's tasks 8.1/8.2). Not runnable in a sandbox without AWS credentials — do this manually when deploying.
  Verified 2026-09-01 on `prod`: `pulumi up` created all 55 resources; cluster `available`, Data API enabled, security group has zero ingress rules; DDL bootstrap ran via `rds-data execute-statement`; `POST /accounts` (201) and `POST /uploads` presigned-upload (201) both succeeded against a real Cognito-authenticated request (Google IdP login, since the app client only supports OAuth — no password flow). Test account row deleted after.
