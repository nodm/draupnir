# ADR-0005: AWS Region Selection

## Status

Accepted

## Date

2026-08-27

## Deciders

Dmytro Novikov

## Context

[ADR-0001](./0001-mcp-transport.md) through [ADR-0004](./0004-ingestion-flow-shape.md)
picked compute (Lambda + API Gateway REST), auth (Cognito + Managed Login), DB access
(Aurora Serverless v2 via RDS Data API, no VPC for Lambda), and the ingestion pipeline
(S3 → SQS → Lambda, SES for inbound email) — but none of them formally decided **which
AWS region** any of this runs in. ADR-0003 named **eu-north-1 (Stockholm)** as a
"target deployment region" and confirmed RDS Data API landed there, but that was
stated as a working assumption to unblock that ADR's decision, not a resolved choice.
ADR-0004 went further and explicitly flagged the gap as an open action item: *"Confirm
current SES receiving region availability... don't assume region parity with the
Aurora/API Gateway deployment region from ADR-0001–3."* This ADR closes both: it
re-verifies eu-north-1 against current (2026-08) AWS facts rather than carrying the
assumption forward unexamined, and it resolves ADR-0004's specific open question.

Deployment shape: single AWS account, single Pulumi stack (`prod`) — no multi-region,
no per-service region splitting under consideration. Every resource from ADR-0001–4
(Cognito User Pool, Aurora Serverless v2 cluster, Lambda functions, API Gateway REST
APIs, S3 buckets, SQS queue, SES receiving) lands in one region.

**Users and data**: exactly two users (me + wife), both EU residents based in
**Vilnius, Lithuania**. Three data sources feed the app: **SEB Lithuania** and
**Revolut Lithuania** (both EU-regulated banks, statements arrive as email
attachments or CSV per ADR-0004), and **monobank (Ukraine)** — also email/CSV only,
same as the other two. monobank being Ukrainian doesn't add an infrastructure
consideration: it's a data *source*, not a system Draupnir integrates with over an
API in a specific region; the transaction data it sends becomes rows in Aurora
wherever Aurora lives, same as SEB/Revolut's data.

As with prior ADRs, this stack is partly an **AWS Solutions Architect Associate**
study vehicle — region-selection factors (data residency, service availability
grids, latency, pricing tiers, regional rollout patterns) are exam-relevant material
in their own right, so the reasoning here is written out in full even where the
answer turns out to be "it doesn't matter much for 2 users."

### Candidates

**eu-central-1 (Frankfurt)** and **eu-north-1 (Stockholm)** per the prompt, plus a
brief look at **eu-west-1 (Ireland)** — AWS's oldest and largest EU region, the
obvious "is there a materially better option" check. Non-EU regions were not
seriously considered: routing two EU residents' bank data through a non-EU region
by default, with no compute/cost/latency reason to do so, has no upside here and
volunteers a residency question this ADR doesn't need to raise.

### 1. Data residency / GDPR posture

Both users and both EU banks' data originate in the EU. GDPR's substantive rules
(lawful basis, data minimization, retention, breach notification) apply regardless
of which AWS region is picked — region choice is not what makes a system
GDPR-compliant. What region choice *does* affect: keeping data at rest and
processing inside the EU avoids the **international-transfer** question for the
resources this ADR controls directly — no adequacy-decision/Standard Contractual
Clauses analysis is needed just to pick a region, the way it would be for a non-EU
region. This is not a complete legal safe harbor, though: an EU region alone doesn't
eliminate transfer exposure if a subprocessor or AWS support path ever accesses the
data remotely from a third country — that's a real, separate question this ADR
doesn't resolve, just doesn't make worse. **Frankfurt and Stockholm are both inside
the EU** — this axis does not distinguish between them; it only rules out non-EU
regions, which were never a real contender given no other requirement points there.

### 2. Service and feature availability — verified, not assumed

Checked directly against current AWS documentation rather than carried over from
ADR-0003's working assumption:

- **RDS Data API for Aurora PostgreSQL**: GA in **eu-central-1 since Dec 2023**
  (one of the four launch regions), GA in **eu-north-1 since 2025-02-26** (a
  10-region expansion). Both current.
  ([AWS: Aurora PostgreSQL RDS Data API](https://aws.amazon.com/about-aws/whats-new/2023/12/amazon-aurora-postgresql-rds-data-api/),
  [AWS: 10 additional regions incl. Stockholm](https://aws.amazon.com/about-aws/whats-new/2025/02/amazon-rds-data-api-aurora-10-additional-regions))
- **Aurora Serverless v2**: generally available in both regions; no gap.
- **Cognito Managed Login**: available in all commercial AWS regions where Cognito
  itself runs (the initial Nov 2024 launch excluded only GovCloud, which closed the
  gap in Mar 2025) — both Frankfurt and Stockholm have run Cognito for years, no
  regional restriction found for Managed Login specifically.
  ([AWS: Managed Login announcement](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-cognito-managed-login))
- **SES email receiving** — the item ADR-0004 explicitly left open. Checked the
  authoritative endpoint table directly: **both eu-central-1 and eu-north-1 have an
  `inbound-smtp` endpoint**, i.e. both support email receiving today.
  ([AWS General Reference: SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html#ses_inbound_endpoints))
  This resolves ADR-0004's open item: region choice does not force SES into a
  different region from the rest of the stack. Worth getting the *mechanism* right
  for the data-access design, though, since ADR-0004's receipt rule uses an S3
  action only — no SNS or Lambda action on the rule itself. SES's own same-region
  rule (*"with the exception of Amazon S3 buckets, all of the AWS resources that you
  use for receiving email with SES have to be in the same AWS Region as the SES
  endpoint"*) binds only the resources a receipt rule *directly* references, which
  here is nothing but the S3 bucket — and even that bucket only needs to sit in
  *some* region where SES receiving is available, not necessarily the same one as
  the rule set itself, per the S3-action docs.
  ([AWS: S3 action, region note](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html))
  The reason the SQS queue and ingestion Lambda from ADR-0004 still end up pinned to
  `eu-north-1` isn't SES's rule at all — it's two separate, ordinary same-region
  requirements downstream: an S3 bucket's event notifications can only target an SQS
  queue in the same region, and an SQS event-source mapping can only invoke a Lambda
  function in the same region. Same practical outcome (everything co-located), for a
  different, more accurate reason.
  ([AWS: Email receiving region constraint](https://docs.aws.amazon.com/ses/latest/dg/regions.html#region-receive-email))

**Net result: no feature-availability gap between the two candidates as of
2026-08.** This is a materially different, and better-supported, answer than simply
assuming parity — the SES check in particular could have gone the other way.

### 3. Latency from Vilnius

No AWS region exists in the Baltics, so this is "which region is a shorter network
hop from Vilnius," not "which region is local." Measured via WonderNetwork's
distributed ping mesh (a proxy for real network path latency, not a synthetic
great-circle estimate):

| Route | Latency |
|---|---|
| Vilnius → Frankfurt | 32.63 ms |
| Vilnius → Stockholm | **15.84 ms** |

([WonderNetwork: pings from Vilnius](https://wondernetwork.com/pings/Vilnius))

Stockholm is roughly **half** Frankfurt's latency from Vilnius — consistent with
geography (a Baltic Sea subsea-cable hop to Sweden vs. a longer overland path to
Frankfurt) and with the Baltic states' well-connected peering into the Nordic
internet backbone (Riga: 6.32 ms, Tallinn: 24.32 ms to Stockholm-region test nodes
on the same page, for reference).

**Whether this is actually significant for this workload**: no. This is an
interactive API + MCP-tool-calling workload, not high-frequency or real-time.
ADR-0001 already accepted that Lambda cold starts (~200–500ms) and multi-second LLM
tool-calling round trips dominate user-perceived latency; ADR-0003 added an extra
Data API HTTP hop on top of that for the same reason. A 17ms difference in one leg
of a request that already runs to hundreds of milliseconds or seconds end-to-end is
real and measurable, but not a deciding factor on its own — it's a tiebreaker
alongside cost, not a requirement either candidate fails.

### 4. Cost

AWS does not publish a single side-by-side regional pricing table for Aurora
Serverless v2 ACU-hour or Lambda GB-second rates in an easily diffable form (both
require selecting a region in the pricing calculator individually) — exact current
figures should be pulled from the [AWS Pricing Calculator](https://calculator.aws)
at IaC-build time rather than trusted from this ADR months later. What's available
now, from a third-party regional cost benchmark comparing the same instance/service
types across regions:

| Service | Stockholm (eu-north-1) | Frankfurt (eu-central-1) | Frankfurt premium |
|---|---|---|---|
| RDS/Aurora (db.r5/r4.2xlarge, as a proxy for Aurora compute pricing) | $1.20/hr | $1.40/hr | **+17%** |
| EC2 (m5.2xlarge) | $0.408/hr | $0.460/hr | +13% |
| S3 Standard (first 50TB) | $0.0230/GB | $0.0245/GB | +7% |
| DynamoDB on-demand writes | $1.343/M | $1.525/M | +14% |

([tecRacer: European region cost benchmark](https://www.tecracer.com/blog/2022/11/high-level-aws-cost-benchmark-in-european-regions-including-new-zurich-region.html))

Aurora compute pricing (including Serverless v2 ACU-hour, which is derived from the
same underlying compute economics) tracks this same regional multiplier — Frankfurt
consistently prices above Stockholm across every service checked, and multiple
independent sources describe **Stockholm as the least expensive AWS region in
Europe**, including specifically versus Ireland (eu-west-1), which loses on both
cost (~5% pricier than Stockholm in the same benchmark family) and latency from
Vilnius (Dublin: 48.55ms — worse than both Frankfurt and Stockholm) — the reason
Ireland doesn't get a full row in the options table below.
([tecRacer benchmark](https://www.tecracer.com/blog/2022/11/high-level-aws-cost-benchmark-in-european-regions-including-new-zurich-region.html))

At 2-user scale the absolute dollar difference is small either way (a handful of
dollars a month on Aurora ACU spend, cents on Lambda), but it's a consistent,
one-directional signal, not a wash — every service checked favors Stockholm, none
favor Frankfurt.

### 5. Regional expansion pace — a real, historical pattern worth flagging

**eu-north-1 (Stockholm) opened Dec 2018; eu-central-1 (Frankfurt) opened Oct
2014** — Frankfurt is one of AWS's oldest and largest EU regions, Stockholm is
newer. This shows up concretely in the RDS Data API timeline pulled for this ADR:
Frankfurt had it from the Dec 2023 GA; Stockholm didn't get it until the **Feb 2025
expansion, roughly 14 months later**. That's not a hypothetical concern — it already
happened, to the exact service this stack depends on, and this ADR only discovered
Stockholm had caught up by checking rather than assuming.

Both regions are at feature parity for everything Draupnir needs *today* (per
section 2), so this isn't a current blocker. But it's a legitimate asymmetric risk
going forward: this project deliberately rides recent AWS launches (Data API's 2023
redesign, API Gateway response streaming from Nov 2025 per ADR-0001, Cognito Managed
Login), and Frankfurt has a better track record of getting new features on day one.
Worth a standing watch item rather than a reason to switch regions now — see Action
Items.

## Decision

**Deploy all infrastructure to eu-north-1 (Stockholm).**

- Every resource across ADR-0001–4 (Cognito User Pool, Aurora Serverless v2 cluster
  + Data API, Lambda functions, API Gateway REST APIs, S3 buckets, SQS queue + DLQ,
  SES receiving) is provisioned in `eu-north-1` as one Pulumi stack (`prod`).
- This **confirms** ADR-0003's working assumption rather than overturning it, but on
  the basis of this ADR's direct verification (SES receiving parity, current Data
  API availability, actual latency/cost numbers) — not by inheriting it unchecked.
- The S3-event-notification and SQS-event-source-mapping same-region requirements
  (section 2) mean the SQS queue, DLQ, and ingestion Lambda from ADR-0004 must stay
  in `eu-north-1` alongside the S3 buckets — not because SES itself requires it
  (its receipt rule only touches S3 directly), but as an ordinary consequence of how
  S3 and SQS event sourcing work regionally.

## Options Considered

| Option | GDPR/residency | Data API / Managed Login / SES receiving | Latency from Vilnius | Relative cost | Regional maturity |
|---|---|---|---|---|---|
| **eu-north-1 (Stockholm) — chosen** | EU, no differentiator | All confirmed available (Data API since 2025-02-26) | **15.84 ms** — best of the three | Lowest checked (Aurora/RDS ~17% cheaper than Frankfurt) | Newer region (opened 2018); historically ~14mo behind Frankfurt on Data API rollout, now caught up |
| eu-central-1 (Frankfurt) | EU, no differentiator | All confirmed available (Data API since launch, Dec 2023) | 32.63 ms — ~2x Stockholm | Highest of the three checked | Older, larger EU region; best track record for day-one feature availability |
| eu-west-1 (Ireland) | EU, no differentiator | Not individually re-verified — AWS's most mature EU region, no reason to expect a gap | 48.55 ms — worst of the three | ~5% pricier than Stockholm per the same benchmark family | Oldest EU region (2007); ruled out on cost + latency before a full feature check was needed |

## Trade-off Analysis

- **Why Stockholm over Frankfurt despite Frankfurt's better feature-rollout track
  record**: the track-record risk is about *future* AWS launches landing in
  Frankfurt first, not a gap in what's needed today — every service this stack
  actually uses was independently re-verified as available in Stockholm right now.
  Weighed against a *confirmed* ~17% Aurora cost saving and roughly half the network
  latency from Vilnius, a "might lag by some months on some future feature" risk is
  the weaker signal. If a future ADR needs a service that hasn't reached Stockholm
  yet, that's the trigger to revisit — not a reason to preemptively pay Frankfurt's
  premium for a risk that hasn't materialized.
- **Why the latency difference doesn't drive the decision on its own**: 17ms is real
  and easy to source (WonderNetwork), but ADR-0001 and ADR-0003 already established
  that this workload's latency budget is dominated by Lambda cold starts, the Data
  API HTTP hop, and multi-second LLM tool-calling round trips — not the single-digit
  milliseconds a region choice can move. Treating it as a tiebreaker rather than the
  headline argument keeps this ADR's reasoning honest with what ADR-0001/0003
  already concluded about where the latency actually goes.
- **Why Ireland was ruled out without a full service-by-service check**: it lost on
  both of the two "hard" axes (cost and latency from Vilnius) against Stockholm
  before feature availability was even in question. Spending the same verification
  effort on a region that's already behind on the criteria that matter most here
  would be exam-completeness for its own sake, not decision-relevant — the same
  "problem doesn't apply, don't solve it anyway" reasoning ADR-0003 and ADR-0004
  both already applied to RDS Proxy and SNS respectively.
- **Why the SES receiving check mattered even though it didn't change the region
  pick**: it resolved a real unknown from ADR-0004 (parity was not guaranteed, and
  the historical Data API gap shows region parity for newer AWS features cannot be
  assumed). It also surfaced a design detail worth stating precisely: the pipeline's
  same-region requirement comes from S3→SQS event notifications and the SQS→Lambda
  event-source mapping, not from SES's own same-region rule (which, given
  ADR-0004's S3-only receipt-rule action, doesn't reach SQS or Lambda at all). Same
  practical constraint on future IaC — nothing can casually move SQS/Lambda to a
  "cheaper" or "closer" region independent of the rest of the pipeline — but
  attributed to the right mechanism, so it isn't rediscovered the hard way (or
  fixed by touching the wrong resource) during Pulumi work.

## Consequences

- Pulumi's `prod` stack targets `eu-north-1` for every resource from ADR-0001–4;
  no per-service region overrides.
- The ingestion pipeline's same-region requirement is now documented with its actual
  mechanism (S3 event notifications → SQS, SQS event-source mapping → Lambda, both
  ordinary regional constraints — not a direct SES rule on SQS/Lambda, since the
  receipt rule's only direct action is the S3 delivery), not an implicit assumption.
- Exact Aurora Serverless v2 ACU-hour and Lambda GB-second prices for `eu-north-1`
  were not pinned to specific dollar figures in this ADR — AWS doesn't publish a
  clean diffable regional table, and third-party benchmark figures (tecRacer) are
  from proxy instance types, not Aurora Serverless v2 ACU pricing directly. Pull
  current numbers from the AWS Pricing Calculator when estimating actual monthly
  spend, not from this document.
- If a future ADR needs an AWS feature/service not yet available in `eu-north-1`
  (the Data API precedent shows this can happen, ~14 months behind Frankfurt at
  worst observed so far), that's the trigger to revisit this decision for that
  specific dependency — not a reason to have picked Frankfurt preemptively today.
- monobank's Ukraine origin was confirmed to have no infrastructure consequence:
  it's an email/CSV data source per ADR-0004, not a service Draupnir calls, so it
  doesn't factor into region selection the way a bank API integration would.

## Action Items

- [x] Verify RDS Data API availability in both eu-central-1 and eu-north-1 —
      confirmed both current (Frankfurt since Dec 2023 GA, Stockholm since
      2025-02-26).
- [x] Verify Cognito Managed Login region availability — confirmed available
      wherever Cognito itself runs, no regional gap between candidates.
- [x] Resolve ADR-0004's open item on SES email-receiving region parity —
      confirmed both eu-central-1 and eu-north-1 support SES receiving today; the
      pipeline's actual same-region mechanism (S3→SQS event notifications, SQS→Lambda
      event-source mapping — not a direct SES rule on SQS/Lambda) is now documented.
- [ ] Set the Pulumi provider/stack region config to `eu-north-1` for the `prod`
      stack before provisioning any ADR-0001–4 resources.
- [ ] Pull current Aurora Serverless v2 ACU-hour and Lambda GB-second pricing for
      `eu-north-1` from the AWS Pricing Calculator when building a cost estimate —
      this ADR's cost figures are directional (proxy instance-type benchmarks), not
      exact current Aurora Serverless v2 rates.
- [ ] Revisit this ADR if a future dependency isn't yet available in `eu-north-1` —
      check regional availability before assuming parity, the same discipline this
      ADR applied to SES receiving rather than carrying ADR-0003's assumption
      forward unchecked.
