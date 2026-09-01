## Context

See `proposal.md` - Why. ADR-0003 (`docs/adr/0003-aurora-access-pattern.md`) already decided
*how* Lambda talks to the DB (RDS Data API, no VPC attachment for Lambda); this design covers
only what's left — actually provisioning the cluster ADR-0003 assumed would exist. Re-verified
against current AWS docs (2026-08-30, not from training) since ADR-0003 flagged its own
version numbers as something to confirm at provisioning time:
- RDS Data API for Aurora PostgreSQL still requires 13.11 / 14.8 / 15.3 or higher — unchanged
  since ADR-0003 was written.
  ([AWS: Aurora PostgreSQL now supports RDS Data API](https://aws.amazon.com/about-aws/whats-new/2023/12/amazon-aurora-postgresql-rds-data-api/))
- Current Aurora PostgreSQL LTS releases as of 2026-08-30 run up to 17.7, well above that
  floor — see Decisions for why this design doesn't pin an exact version.
  ([AWS: Aurora PostgreSQL LTS releases](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Updates.LTS.html))
- Pulumi's `aws.rds.Cluster` needs `engineMode: "provisioned"` (not `"serverless"`, which is
  the v1 shape) plus a `serverlessv2ScalingConfiguration` block, and a separate
  `aws.rds.ClusterInstance` with `instanceClass: "db.serverless"` — Serverless v2 clusters
  aren't fully serverless at the resource-graph level, they still need an instance resource.
  ([Pulumi: Create AWS RDS Aurora Clusters](https://www.pulumi.com/guides/how-to/aws-rds-cluster/),
  [Pulumi registry: aws.rds.Cluster](https://www.pulumi.com/registry/packages/aws/api-docs/rds/cluster/))

## Goals / Non-Goals

**Goals:**
- Stand up exactly what `import-bank-statements`'s `DbConfig` contract needs: a reachable
  Aurora Serverless v2 cluster with Data API enabled, and a real secret backing it.
- Keep the "near-zero idle cost for 2 occasional users" framing from ADR-0001/ADR-0003 —
  minimal ACU range, no NAT Gateway, no resources beyond what Data API access requires.

**Non-Goals:**
- Secret rotation (ADR-0003 action item, deferred — see proposal's Out of scope).
- Multi-AZ high availability tuning, read replicas, or performance tuning — this is a 2-user
  app; a single-instance Serverless v2 cluster is enough until a real need appears.
- Backup/retention policy beyond Aurora's default — revisit only if data loss risk becomes a
  concern.

## Decisions

**Module placement**: `infra/lib/aurora.ts`, exporting `createAuroraCluster(provider):
AuroraCluster` where `AuroraCluster` includes `dbConfig: DbConfig` (the same shape
`infra/lib/ingestionPipeline.ts` already defines and consumes) plus the underlying `vpc` and
`cluster` resources for anything that needs them later — there's no separate `secret`
resource to expose since it's RDS-owned (`manageMasterUserPassword`), represented only by its
ARN inside `dbConfig`. `infra/index.ts` calls this before `loadDbConfig()`'s current call site
and passes `auroraCluster.dbConfig` through instead.

**`loadDbConfig()` is removed, not parameterized**: the function existed only as a config-read
placeholder documented as temporary (see its own comment in `ingestionPipeline.ts`). Once
`aurora.ts` produces a real `DbConfig`, keeping a second, unused path that reads
`pulumi.Config` would be dead code inviting drift. `DbConfig` the *type* stays in
`ingestionPipeline.ts` (still consumed by `dataApiPolicyStatements()`); only the placeholder
*function* goes.

**VPC shape — minimal, no NAT**: a single VPC with two private subnets across two AZs (Aurora
requires a DB subnet group spanning ≥2 AZs), no NAT Gateway and no internet gateway. Nothing
in this VPC needs outbound internet access — the cluster itself doesn't initiate outbound
calls, and per ADR-0003 no Lambda joins this VPC — so a NAT Gateway would be pure unused
fixed cost, which ADR-0003 explicitly identified as the cost Data API avoids paying. Two
subnets are the minimum Aurora accepts, not a HA decision.

**Security group — no ingress rules**: an SG attached to the cluster with zero ingress rules.
Data API doesn't reach the cluster over the VPC network path (it's a separate internal AWS
mechanism), so there's no compute resource that ever needs a rule granting it access — an
empty ingress list is the correct steady state, not a placeholder to fill in later.

**Capacity — scale to zero**: `serverlessv2ScalingConfiguration` with `minCapacity: 0`,
`maxCapacity: 1`, and `secondsUntilAutoPause: 300` (AWS's default). Aurora PostgreSQL 17.7
supports 0-ACU auto-pause (GA since Nov 2024, requires 13.15+/14.12+/15.7+/16.3+), and the
cost gap between this and a non-zero floor is the difference between near-zero and a real
~$40+/month fixed cost at 2-user, occasional-use load — worth the several-seconds-to-~1-minute
resume latency on the first request after an idle period.

**Engine version — not pinned in this document**: rather than hardcoding a specific
`x.y` engine version here (which drifts as AWS ships updates), the implementing task picks
the current default/LTS Aurora PostgreSQL version available via
`aws rds describe-db-engine-versions --engine aurora-postgresql` (or the Pulumi provider's
equivalent lookup) at deploy time, and confirms it's ≥ 13.11/14.8/15.3 per the Requirement in
`specs/aurora-data-access/spec.md`. Every current LTS release is already well above that
floor, so this is a formality, not a real risk.

**Credential — AWS-managed master password, not Pulumi-generated**: `aws.rds.Cluster`
supports `manageMasterUserPassword: true`, which has RDS itself create and own the
Secrets Manager secret (exposed back as `cluster.masterUserSecrets[0].secretArn`) —
no `masterPassword` is ever set, so no password material exists in Pulumi state, our
code, or a separate `random.RandomPassword`/`aws.secretsmanager.Secret` resource pair
to manage. This is a better fit than the originally-considered "Pulumi-generates-it"
approach: fewer resources, no extra `@pulumi/random` dependency, and it's the same
mechanism AWS's own Secrets Manager-integration docs recommend for this exact case.
([Pulumi: aws.rds.Cluster — Managed Master Passwords](https://www.pulumi.com/registry/packages/aws/api-docs/rds/cluster/))

## Risks / Trade-offs

- **No rotation** → the DB credential never expires or rotates automatically. Mitigation:
  acceptable at 2-user scale per ADR-0003's own deferral; tracked as that ADR's own follow-up
  action item, not silently dropped.
- **Single-instance cluster, no automatic failover target** → an AZ-level outage affecting the
  one instance causes downtime until Aurora recovers it. Mitigation: acceptable for a 2-user
  app; add a second instance later if uptime requirements change — Serverless v2 supports
  adding a reader without a schema/access-pattern change.
- **Resume-from-pause latency vs. API Gateway's timeout ceiling** → the first DB-backed request
  after an idle period can take several seconds to ~1 minute to resume the cluster, while API
  Gateway's REST API integration timeout caps at 29s without an AWS Service Quota increase —
  and that increase is only available on a Regional or private REST API, not the default
  edge-optimized one. Mitigation: `ingestionApi.ts`'s `RestApi` is configured Regional (no
  CloudFront benefit for a private, Cognito-authenticated API anyway), and the
  `accounts`/`presigned-upload` Lambdas and their API Gateway integrations are set to the 29s
  ceiling (up from the 3s default, which failed on essentially every request); a rare
  worst-case resume can still exceed even that and return a 504 — acceptable for a 2-user app
  given the cost difference (see Decisions), revisit with the now-available Service Quota
  increase or a client-side retry if this proves disruptive in practice.
- **Longer per-request Lambda hold with no throttling** → raising the DB-backed routes' timeout
  3s→29s means a hammering/replaying client can now legitimately hold a Lambda slot ~10x longer
  per invocation, and there's no `UsagePlan`, `reservedConcurrentExecutions`, or WAF in `infra/`
  to cap it. Mitigation: acceptable for a 2-user app — Cognito auth is unchanged, this only
  widens the blast radius of an already-required token compromise, not a new vulnerability.
  Add API Gateway throttling/a usage plan as a follow-up if traffic or user count grows.
