## Why

`import-bank-statements` built the RDS Data API access layer (`ingestion/src/lib/dataApi.ts`)
against ADR-0003's decision, but no Aurora cluster backs it — `loadDbConfig()` in
`infra/lib/ingestionPipeline.ts` reads `dbClusterArn`/`dbSecretArn`/`dbName` as bare Pulumi
config placeholders with nothing behind them, deliberately deferred at the time. This is
ADR-0003's own unchecked action-items list (`docs/adr/0003-aurora-access-pattern.md`); until
it's done, nothing can actually be deployed, and `import-bank-statements`'s end-to-end
verification tasks (8.1/8.2) stay blocked.

## What Changes

- Provision an Aurora Serverless v2 (PostgreSQL) cluster with RDS Data API enabled, per
  ADR-0003's Decision and Consequences: a VPC, DB subnet group, and security group with no
  Lambda ingress rule (Lambda reaches the cluster only through Data API's regional HTTPS
  endpoint, never a direct Postgres connection) — confirm the current AWS-documented minimum
  engine version satisfying the Data API floor (13.11 / 14.8 / 15.3+ at ADR write time) before
  picking one.
- Add a Secrets Manager secret holding the DB credential the cluster uses for Data API's
  internal Postgres auth (Data API does not accept IAM-auth tokens, per ADR-0003).
- Replace `loadDbConfig()`'s current config-placeholder read with the new cluster's real
  outputs (cluster ARN, secret ARN, database name), so `infra/lib/ingestionPipeline.ts` and
  `infra/lib/ingestionApi.ts`'s `dataApiPolicyStatements()` consume live resource references
  instead of manually-filled stack config.
- **Out of scope**: Secrets Manager rotation for the DB credential (ADR-0003 lists it as a
  separate follow-up action item, not required for a first deploy at 2-user scale); any
  schema/data migration; any consumer beyond what `import-bank-statements` already expects.

## Capabilities

### New Capabilities
- `aurora-data-access`: the Aurora Serverless v2 cluster, its VPC/subnet/security-group
  shell, the Data API-auth Secrets Manager secret, and the `DbConfig` wiring that exposes
  these as real resource references to the rest of `infra`.

### Modified Capabilities
(none — this only backs the config surface `import-bank-statements` already defined; no
spec-level behavior in that change's capabilities changes)

## Impact

- **New Pulumi resources** (`infra`): VPC, DB subnet group, security group, Aurora Serverless
  v2 cluster (Data API enabled), Secrets Manager secret.
- **`infra/lib/ingestionPipeline.ts`**: `loadDbConfig()` changes from a `pulumi.Config` read
  to consuming the new cluster module's outputs directly.
- **`infra/index.ts`**: wires the new Aurora module in ahead of `loadDbConfig()`.
- **No changes** to `shared`, `ingestion`, or `mcp` application code — this is infra-only,
  unblocking `import-bank-statements`'s deploy-dependent tasks (8.1/8.2) without touching its
  already-implemented code.
