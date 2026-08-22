# ADR-0003: Aurora Access Pattern from Lambda

## Status

Accepted

## Date

2026-08-22

## Deciders

Dmytro Novikov

## Context

[ADR-0001](./0001-mcp-transport.md) picked Lambda + API Gateway REST as the compute
shape for the MCP server; the primary app API follows the same shape per
[ADR-0002](./0002-auth-request-flow.md). Both ADRs assumed a Postgres-compatible
store existed but deliberately deferred *how Lambda talks to it*. This ADR resolves
that for **Aurora Serverless v2 (PostgreSQL-compatible)**, holding the multi-currency
transaction/account/category schema with row-level ownership (`owner_user_id` +
`share_grants`, per ADR-0002).

Three shapes were on the table:

1. **RDS Data API** — HTTP-based, IAM/SigV4-signed calls to a regional AWS API
   endpoint; the service manages connections to the cluster internally. No driver,
   no connection object in Lambda code.
2. **RDS Proxy + native Postgres driver** (`pg`/`postgres.js`) — a managed proxy
   that pools/multiplexes real Postgres connections; Lambda still opens a normal
   TCP connection, just to the proxy instead of the cluster directly.
3. **Plain Lambda → Aurora, no proxy** — Lambda opens a native Postgres connection
   straight to the cluster endpoint, one per concurrent execution environment.

The three differ mainly on **where the connection-management problem gets solved**
(HTTP API vs. proxy vs. nowhere) and, as a direct consequence, **whether Aurora ends
up needing Lambda inside its VPC** — which has its own cost and complexity tail.

A framing note, since this stack is partly an AWS Solutions Architect Associate
study vehicle: **RDS Proxy is the canonical exam answer** to "Lambda + RDS,
mitigate connection exhaustion." It's worth working through in full even though it
isn't the pick here — see Trade-off Analysis.

Two facts changed the calculus from older received wisdom:

- **RDS Data API for Aurora PostgreSQL was redesigned and made GA for both
  Serverless v2 and provisioned instances in Dec 2023**, removing the original
  Data API's request-rate limit and adding unlimited-scale claims. It supports
  Aurora PostgreSQL 13.11, 14.8, 15.3, and higher. Regional coverage has expanded
  since GA but is **not yet all commercial regions**. Target deployment region is
  **eu-north-1 (Stockholm)**; Data API reached that region 2025-02-26 as part of a
  10-region expansion — confirmed available, not assumed.
  ([AWS: Aurora PostgreSQL now supports RDS Data API](https://aws.amazon.com/about-aws/whats-new/2023/12/amazon-aurora-postgresql-rds-data-api/),
  [AWS: 10 additional regions incl. Stockholm](https://aws.amazon.com/about-aws/whats-new/2025/02/amazon-rds-data-api-aurora-10-additional-regions))
- **Lambda's VPC cold-start penalty is not what older blog posts describe.** Since
  Lambda moved to shared, VPC-level Hyperplane ENIs in 2019, VPC-attached
  functions no longer pay the old 10+ second ENI-provisioning cold start — the
  penalty today is on the order of a few hundred milliseconds versus a non-VPC
  cold start, not an order-of-magnitude difference. This is worth stating
  explicitly because "VPC Lambda = slow cold starts" is exactly the kind of stale
  claim that's easy to repeat uncritically; it's a minor factor here, not the
  deciding one.
  ([IOpipe: Lambda VPC upgrades with Hyperplane](https://read.iopipe.com/aws-lambda-vpc-upgrades-with-e246cbf4663e))

What *is* still a real, current cost concern for VPC-attached Lambda: a **NAT
Gateway has a flat ~$0.045/hr charge regardless of traffic** (≈$32–33/mo just to
exist, before any per-GB data processing), which any VPC-attached Lambda needs if
it makes calls outside the VPC (any AWS API without a VPC endpoint, or the open
internet) and lives in a private subnet. That fixed cost runs directly against
ADR-0001's "near-zero idle cost for 2 occasional users" framing.

## Decision

**Use RDS Data API. Lambda functions call Aurora over the Data API's HTTPS
endpoint; no Postgres driver, no connection object, no VPC attachment for the
Lambda functions themselves.**

- Aurora Serverless v2 itself still requires a VPC and DB subnet group — that's an
  Aurora property, not a Data API opt-out — but **the Lambda functions do not join
  that VPC**. Data API is reached as a regular regional AWS API (SigV4-signed HTTPS
  to `rds-data.<region>.amazonaws.com`), the same networking shape as calling S3 or
  DynamoDB from Lambda. This is the concrete payoff of this option: it's the only
  one of the three where Aurora sits in a VPC but Lambda doesn't have to.
- The cluster keeps a Secrets Manager secret holding the DB username/password; the
  Data API uses that secret to authenticate to Postgres on Lambda's behalf. IAM
  policy on the Lambda execution role grants `rds-data:ExecuteStatement` /
  `BatchExecuteStatement` and `secretsmanager:GetSecretValue` on that specific
  secret — it does **not** grant Postgres wire-level access, so there's no
  security-group/subnet story to design at all for this path.
- SQL goes through Data API's parameterized `ExecuteStatement`/`BatchExecuteStatement`
  calls (typed parameter objects, not driver-level placeholders) and its own
  `BeginTransaction`/`CommitTransaction`/`RollbackTransaction` calls for anything
  needing more than one statement atomically. This is a real API-shape difference
  from a normal `pg` client, not a drop-in swap — confirm current parameter-binding
  and type-coercion behavior against the current SDK docs when building the data
  access layer, not from memory of the pre-2023 Data API.

## Options Considered

| Option | Lambda in VPC? | Connection handling | Fixed monthly cost | Complexity |
|---|---|---|---|---|
| RDS Data API (chosen) | **No** | None — Data API pools internally, HTTP request/response per call | Pay-per-request past 1M free/mo; Secrets Manager secret (~$0.40/mo) | Lowest — no VPC, no SG, no driver/pool config |
| RDS Proxy + native driver | **Yes** — proxy and Lambda must share VPC/subnets | Proxy pools/multiplexes real Postgres connections behind it | Proxy hourly charge (~vCPU-based) + NAT Gateway (~$32–33/mo) if private-subnet internet egress is needed | Medium — VPC, subnets, SGs, proxy resource, IAM-auth-to-proxy wiring |
| Plain Lambda → Aurora, no proxy | **Yes** | None — each concurrent execution environment opens its own connection | NAT Gateway (~$32–33/mo) if egress needed, no proxy charge | Medium — same VPC/SG surface as RDS Proxy, minus the proxy resource itself |

## Trade-off Analysis

- **Why not plain Lambda → Aurora, no proxy**: rejected outright, not just
  disfavored. Each concurrently-running Lambda execution environment holds its own
  Postgres connection for its lifetime; connections aren't shared across
  concurrently-running environments the way they'd be pooled in an always-on
  server process. Aurora Serverless v2's `max_connections` scales with ACUs, but
  at the low end of the ACU range (where a 2-user app mostly idles) that ceiling
  is low enough that a burst of concurrent invocations — parallel MCP tool calls,
  a retry storm, both users' devices hitting the API at once — can exhaust it. This
  is exactly the failure mode RDS Proxy and Data API both exist to prevent; picking
  the option that prevents neither has no offsetting benefit.
- **RDS Proxy vs. Data API — the exam-canonical answer vs. the one chosen here**:
  RDS Proxy is what AWS's own exam material points to for "Lambda talking to
  RDS/Aurora at scale," and it's the closer match if this were an always-on
  service or needed full native-driver fidelity (session-level settings, cursors,
  `LISTEN`/`NOTIFY`, long-lived transactions). None of that is needed yet — the
  app's query shape is short, independent, parameterized statements. What RDS
  Proxy would cost here that Data API doesn't: mandatory VPC attachment for every
  Lambda that touches the DB, which either pulls in a NAT Gateway's flat ~$32/mo
  (if those Lambdas need any non-VPC AWS API or internet access) or a set of VPC
  interface endpoints per AWS service they call — either way, fixed monthly spend
  and IaC surface that two occasional users don't currently justify. Cold start is
  explicitly *not* part of this trade-off, per the Hyperplane ENI correction above.
- **Data API's real cost, honestly stated**: it's not free of trade-offs. Calls go
  through an extra HTTP hop to a regional API versus a warm native connection, so
  per-call latency is higher than a pooled driver connection would give — acceptable
  here for the same reason ADR-0001 accepted Lambda cold starts: interactive
  LLM-tool-calling round trips already run multi-second, so this isn't the
  bottleneck in the user-perceived latency budget. It also still depends on
  Secrets Manager (small fixed cost, and a credential-rotation surface to manage)
  because Data API authenticates to Postgres with the secret's username/password —
  it does **not** accept IAM-generated auth tokens the way a direct IAM-authenticated
  driver connection or RDS Proxy connection can. That's a real capability Data API
  gives up, not an oversight in this ADR.
- **Statelessness alignment**: Data API's call-per-request, no-held-connection
  shape mirrors the stateless-by-spec Streamable HTTP transport from ADR-0001 —
  neither the MCP transport nor the DB access path leaves Lambda holding
  long-lived state between invocations. Choosing RDS Proxy or a direct connection
  wouldn't break that, but Data API is the option requiring nothing to enforce it.

## Consequences

- Aurora Serverless v2 still needs its own VPC, DB subnet group, and security
  group as a matter of how Aurora works — this ADR does not eliminate that
  resource, it only keeps Lambda out of it. Pulumi IaC needs: Aurora Serverless v2
  cluster + subnet group + SG (ingress from nowhere but Data API's own internal
  path — no Lambda SG rule needed), Secrets Manager secret for the DB credential,
  Data API enabled on the cluster.
- The Lambda execution role's IAM policy becomes the actual access-control surface
  for DB connectivity (`rds-data:ExecuteStatement`/`BatchExecuteStatement`/
  `BeginTransaction`/`CommitTransaction`/`RollbackTransaction` scoped to the
  cluster ARN, `secretsmanager:GetSecretValue` scoped to the one secret) — there is
  no security-group/VPC boundary doing this job for the Lambda side, unlike the
  RDS Proxy or direct-connection options.
- The data-access layer is written against Data API's `ExecuteStatement`/typed
  parameter shape, not a standard `pg`-compatible driver. This is a real coupling:
  moving to RDS Proxy or a direct connection later isn't a config flip, it's
  rewriting the query layer to a driver-based one. Worth designing the repository/
  query layer behind a narrow interface from the start so that migration, if ever
  needed (e.g., a future requirement for `LISTEN`/`NOTIFY`, long transactions, or
  materially lower per-call latency), is contained to one module.
- Every query still carries the ADR-0002 ownership/grant predicate
  (`owner_user_id = :sub` / `share_grants` `EXISTS` join) as a Data API SQL
  parameter — Data API changes *how* the statement is sent, not the row-level
  security model itself.
- No NAT Gateway, VPC endpoints, or Lambda SG/subnet config needed for DB access
  specifically. If a *different* future requirement puts Lambda in a VPC anyway
  (e.g., an internal-only downstream service), Data API's independence from that
  VPC still holds — the DB access path doesn't force the networking decision, but
  it also doesn't ride along "for free" if a VPC gets added for other reasons.

## Action Items

- [x] Confirm RDS Data API for Aurora PostgreSQL is available in the target
      deployment region — eu-north-1 (Stockholm), confirmed available since
      2025-02-26.
- [ ] Confirm target Aurora PostgreSQL engine version meets the Data API floor
      (13.11 / 14.8 / 15.3+) when picking the cluster's engine version.
- [ ] Design the data-access layer behind a narrow repository interface (not
      Data API calls scattered through handler code), so a later move to RDS Proxy
      or a direct driver — if `LISTEN`/`NOTIFY`, long transactions, or latency ever
      force it — is contained to one module.
- [ ] Verify current Data API parameter-binding, type-coercion, and response
      size/pagination limits against the current AWS SDK docs before writing the
      repository layer — don't assume pre-2023-redesign Data API behavior.
- [ ] Add Pulumi resources: Aurora Serverless v2 cluster (Data API enabled),
      DB subnet group + SG (no Lambda ingress rule needed), Secrets Manager
      secret for the DB credential, Lambda execution role IAM policy scoped to
      `rds-data:*` on the cluster ARN and `secretsmanager:GetSecretValue` on the
      one secret.
- [ ] Set up Secrets Manager rotation for the DB credential secret; Data API
      depends on that secret staying valid since it can't fall back to IAM auth
      tokens.
- [ ] Revisit this ADR if a query pattern emerges that Data API can't express
      well (long-lived transactions, `LISTEN`/`NOTIFY`, session-level settings) —
      RDS Proxy is the documented fallback, not a direct connection.
