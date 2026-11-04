# ADR-0004: Statement Ingestion Flow Shape

## Status

Accepted

## Date

2026-08-22

## Deciders

Dmytro Novikov

## Context

[ADR-0001](./0001-mcp-transport.md) through [ADR-0003](./0003-aurora-access-pattern.md)
settled compute (Lambda + API Gateway REST), auth/ownership (Cognito claims +
`owner_user_id`/`share_grants` query-time predicates), and DB access (RDS Data API,
no Lambda VPC attachment). None of them cover how a bank statement actually gets
from a bank into a `transactions` row. This ADR resolves that: the shape of the
ingestion pipeline from "file arrives" to "rows written," for both entry points.

Two entry points, both multi-bank, multi-currency:

- **Manual CSV upload** — the user picks a file in the app and uploads it.
- **Email attachment** — SEB Lithuania, Revolut Lithuania, and monobank Ukraine
  all send periodic statements as email attachments to an address the user
  controls, not through any bank API. This is the only "automatic" ingestion path
  that exists today; there is no bank-API polling in scope.

Hard requirement: **automated dedup against existing transactions.** The same
statement can plausibly be re-imported (user re-uploads a CSV they already
processed) or partially overlap another import for the same account (a CSV export
covering Jan–Mar and a later email statement covering Mar–Apr both contain March).
Silently double-counting a transaction in a personal-finance app is a correctness
bug, not a cosmetic one.

The question posed: **synchronous** (upload/email triggers a Lambda directly,
parses and writes in one invocation) vs. **decoupled** (S3 → SQS → Lambda, or
S3 → SNS fan-out → SQS → Lambda if the two entry points should be unified through
one topic). Three sub-questions shape which fits:

1. **Retry/failure handling** if a parse fails partway through a file.
2. **Ordering guarantees** — does correct dedup actually depend on processing
   order, or is that solved elsewhere?
3. **Whether SQS/SNS deserve a place here at all**, given this stack is partly an
   AWS SAA study vehicle (ADR-0003 already flagged that pattern once, for RDS
   Proxy, and rejected it). The honest version of this question isn't "should we
   use the exam pattern for exam-completeness" — it's whether the problems SQS and
   SNS each exist to solve are actually present in this workload, independent of
   what's on a study list.

Three concrete facts settle most of the sub-questions before getting to a decision
table:

- **SES cannot deliver a received message's attachments to Lambda directly — S3 is
  a required destination, not an optional one.** A receipt rule action set can
  chain S3 (store the raw MIME) and Lambda (process it), but "Lambda alone,
  synchronous, no intermediate storage" is not a configuration SES exposes for
  reading attachment content; the raw MIME (including attachments) only exists as
  an S3 object. Emails delivered to S3 top out at 40 MB (headers included) — no
  constraint at bank-statement sizes.
  ([SES: Deliver to S3 bucket action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html),
  [SES: Invoke Lambda function action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda.html))
  This rules out a purely synchronous email path outright — not disfavored, not
  possible as specced. Whatever shape is chosen has to start from an S3 object for
  the email channel; the only real question is what happens after that.
- **API Gateway REST API has a hard, non-negotiable 10 MB request payload limit**,
  body-only, no override. A CSV upload large enough to matter (a full year of
  monobank transactions, a bulk backfill) can plausibly approach or exceed that
  through a Lambda-backed upload endpoint, and there's no way to raise the ceiling
  — the documented workaround is exactly "presigned URL direct to S3," not a
  bigger payload.
  ([AWS re:Post: API Gateway 10MB payload limit](https://repost.aws/questions/QUgDO6WCrhRfaXwSak8YchEQ/recommendations-for-amazon-s-api-gateway-10mb-payload-limit))
  So even though a synchronous *CSV* path is technically buildable (unlike email),
  building it as a direct multipart-body-to-Lambda endpoint bakes in a payload
  ceiling and ties HTTP response latency to full parse+write completion, for a
  channel that doesn't need either constraint — a presigned S3 PUT sidesteps both
  and, as a side effect, makes the CSV path land in S3 exactly like the email path
  does. There's no independent reason for CSV to be structurally different from
  email once email is forced through S3 anyway.
- **Lambda's own async-invocation retry queue (used when S3 event notifications
  invoke Lambda directly, no SQS in between) retries twice over a window that
  tops out at 6 hours, then discards the event.** SQS standard queues default to
  4 days of retention and go up to 14.
  ([Lambda: async invocation error handling](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html),
  [SQS: queue parameters](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-queue-parameters.html))
  For a personal project where "the ingestion Lambda has a bug and is broken for a
  weekend while it gets fixed" is a realistic failure mode (not a 24/7-oncall
  system), 6 hours of implicit retry budget is thin; days is comfortable. This is
  the concrete, non-exam reason a queue earns a place in the primary path rather
  than being bolted on later as a failure destination.

## Decision

**Decoupled flow: both channels land raw files in S3, S3 Event Notifications feed
one shared standard SQS queue, one ingestion Lambda (SQS-triggered, batch size 1)
parses and writes each file inside a single Data API transaction, dedup is
enforced by a DB-level unique constraint — not by message ordering.**

- **CSV upload**: the primary app API issues a presigned S3 PUT URL scoped to
  `uploads/{owner_sub}/{bank}/{uuid}.csv` (bank selected in the upload UI, `sub`
  from the caller's Cognito claim per ADR-0002 — never trusted from the request
  body). The client PUTs directly to S3; the app Lambda never touches the file
  bytes.
- **Email attachment**: one SES-verified receiving address per user (2 total).
  Receipt rule action chain: S3 (store raw MIME to
  `inbound-email/{recipient}/{ses-message-id}`), no Lambda action on the receipt
  rule itself — S3's own event notification is what fires next, same as the CSV
  path. Which bank sent it is resolved from the `From:` header against a small,
  hardcoded per-user allowlist of known bank sender addresses (same style as
  ADR-0002's Pre Sign-Up email allowlist — a config value, not a DB table, at this
  scale); which user owns it is resolved from the recipient address in the S3 key.
- **Convergence**: both S3 buckets' event notifications target the **same
  standard SQS queue**. This is the "unify the two paths" answer — it's S3 that
  unifies them, not SNS. SNS fan-out is for *multiple independent subscribers* to
  the same event; today there is exactly one subscriber (the ingestion Lambda), so
  a topic would be a hop that does nothing. Revisit if a second independent
  consumer shows up (see Consequences).
- **One ingestion Lambda**, SQS-triggered, batch size 1: reads the S3 object,
  dispatches to a bank-specific parser module (by the `bank` embedded in the S3
  key/allowlist match, not content-sniffing), normalizes rows to a common shape,
  computes a dedup key per row, and writes the whole file's rows inside **one Data
  API transaction** (`BeginTransaction` → N `ExecuteStatement`/`INSERT ... ON
  CONFLICT (dedup_key) DO NOTHING` → `CommitTransaction`, per ADR-0003's Data API
  shape). A parse failure partway rolls the whole transaction back — there is no
  partially-written file state to reason about or clean up.
- **Standard queue, not FIFO. No message ordering is required for correctness.**
  Dedup correctness comes from the DB unique constraint on `dedup_key`
  (deterministic hash of `owner_user_id + account_id + posted_date +
  amount_minor_units + currency + normalized_description`), which makes the write
  idempotent and commutative regardless of arrival order, retry, or two files for
  the same account processing concurrently. FIFO would add message-group-ID
  design and throughput ceilings for a correctness property the DB already
  provides for free.
- **DLQ after `maxReceiveCount`** on the queue, for files that fail every retry
  (malformed export, an unrecognized bank format) — inspectable and redriveable
  from the console, not silently dropped after 6 hours the way plain async-Lambda
  retry would drop them.

## Options Considered

| Option | Handles email attachments? | Retry/failure story | Ordering | Complexity |
|---|---|---|---|---|
| Synchronous, direct-to-Lambda (both channels) | **No** — SES cannot hand Lambda attachment content without an S3 hop | Caller sees failure inline; no automatic retry, user must reupload/bank must resend | N/A | Lowest, but doesn't actually cover the primary automated channel |
| S3 event → Lambda, direct async invoke (no queue) | Yes | Lambda's built-in async retry: 2 attempts, discarded after 6h | N/A — not needed | Low |
| **S3 event → SQS (standard) → Lambda (chosen)** | Yes | SQS redelivery + DLQ; 4–14 day retention window | Not required — DB constraint handles it | Low-medium — one queue, one DLQ, one event-source mapping |
| S3 event → SQS (FIFO, per-account group) → Lambda | Yes | Same as standard, plus strict per-account ordering | Guaranteed, but not load-bearing for anything | Medium — message-group-ID design, throughput ceiling, for no correctness gain |
| S3 event → SNS → SQS → Lambda | Yes | Same as standard SQS | Not required | Higher — topic + subscription with exactly one subscriber today |

## Trade-off Analysis

- **Why not direct async S3→Lambda invoke, given it also retries automatically**:
  the retry exists but the retention doesn't — 6 hours is a real ceiling that a
  broken-over-a-weekend Lambda deploy can blow through on a personal project with
  no oncall. Getting DLQ-style inspectability out of the direct-invoke path
  requires wiring an async failure *destination* (itself typically an SQS queue)
  anyway, so the "simpler" option converges back to needing a queue to be
  operationally honest — better to put it in the primary path from the start than
  bolt it on as an afterthought once a file has already been silently dropped.
- **Why standard SQS over FIFO, despite the prompt's "ordering for correct dedup"
  framing being a fair question to ask**: ordering would matter if correctness
  depended on which of two overlapping imports committed first. It doesn't — the
  `dedup_key` unique constraint plus one atomic transaction per file means two
  concurrent imports for the same account resolve via Postgres's own row-conflict
  handling (`ON CONFLICT DO NOTHING`), not via which SQS message a Lambda happened
  to see first. Reaching for FIFO here would be solving a problem the schema
  already solves, at the cost of message-group design and FIFO's lower throughput
  ceiling — not a real constraint at this volume, but not a reason to pay for it
  either.
- **Why SQS earns its place while SNS doesn't, unlike ADR-0003's RDS Proxy
  rejection**: ADR-0003 rejected the canonical exam answer (RDS Proxy) because the
  problem it solves (connection-pool exhaustion) doesn't apply once Data API is
  chosen — Data API sidesteps the problem rather than solving it differently. SQS
  here is the reverse case: the problem it solves (retention across an outage
  window, inspectable failed messages, one durable convergence point for two
  producers) is genuinely present in this workload, so it's kept for real reasons,
  not exam-completeness. SNS gets the RDS-Proxy treatment instead — the problem it
  solves (fan-out to multiple independent subscribers) has no current instance;
  S3 already unifies the two producers into one queue without it.
- **Why CSV upload conforms to the S3-first shape instead of staying a true
  synchronous request/response**: the email channel is forced through S3 by SES's
  own constraints, so keeping CSV upload as a genuinely different, Lambda-body
  synchronous path would mean maintaining two structurally different pipelines
  duplicating the parse/dedupe/write logic's invocation wrapper, and CSV would
  additionally inherit API Gateway's hard 10 MB body ceiling and tie the HTTP
  response to full parse completion for no benefit. Making CSV upload's only
  "special" step be issuing a presigned URL costs nothing and buys back one
  pipeline instead of two.
- **Batch size 1, deliberately not batched for throughput**: at two users'
  occasional-upload volume there's no cost or latency reason to batch, and batch
  size 1 avoids `ReportBatchItemFailures` partial-batch bookkeeping entirely — one
  message, one file, one transaction, one clear success/failure. Smallest working
  version; revisit only if import volume ever makes per-invocation overhead
  material.

## Consequences

- **Bank-format detection is explicit, not content-sniffed**: CSV path via a
  UI-selected bank embedded in the S3 key; email path via a sender-address
  allowlist per user. Both are small hardcoded config, consistent with ADR-0002's
  allowlist pattern — not a DB table, not inferred from file content. Adding a
  4th bank means adding one parser module and one allowlist entry per user who
  banks there, not a schema change.
- **The `dedup_key` normalization rules (whitespace/casing in descriptions,
  amount rounding, timezone handling for `posted_date`) are per-bank-parser
  responsibility and are not resolved by this ADR** — they need to be nailed down
  when each bank's parser module is written, since SEB/Revolut/monobank will not
  format the same transaction identically. Get this wrong and dedup either
  under-merges (false duplicates) or over-merges (a real second transaction
  silently dropped) — worth a deliberate test fixture per bank, not just
  eyeballing sample statements.
- **One ingestion Lambda for all banks and both channels**, not one per bank or
  one per channel — right-sized for 3 banks/2 users; keeps the IAM role, Data API
  credential wiring, and SQS event-source mapping singular. Revisit only if
  parser complexity or blast-radius isolation ever justifies splitting.
- **Two S3 buckets** (`uploads`, `inbound-email`) rather than one bucket with two
  prefixes — kept separate because their producers need different resource
  policies (SES's `ses.amazonaws.com` principal with recipient-condition access
  vs. the app's own presigned-URL-issuing role); both notify the same queue, so
  the separation costs nothing downstream.
- **If a second independent consumer of "a statement file arrived" ever shows up**
  (e.g., a "statement received" notification to the user, an audit/replication
  consumer that shouldn't share fate with the parser) — that's the trigger to
  revisit the no-SNS decision above, not before.
- Every row the ingestion Lambda writes still carries `owner_user_id` and goes
  through the same Data API parameter-binding path as ADR-0003 describes; this
  ADR does not introduce a second way to write to `transactions`.

## Action Items

- [ ] Add Pulumi resources: two S3 buckets (`uploads`, `inbound-email`) with event
      notifications targeting one shared standard SQS queue; SQS redrive policy to
      a DLQ with a defined `maxReceiveCount`.
- [ ] Provision SES receiving: domain/address verification for the 2 per-user
      inbound addresses, receipt rule set with the S3 action (no Lambda action on
      the rule itself), rule-set activation.
- [ ] Confirm current SES receiving region availability and MX-record setup
      requirements against current docs before provisioning — don't assume
      region parity with the Aurora/API Gateway deployment region from ADR-0001–3.
- [ ] Design the `dedup_key` computation and its normalization rules per bank
      parser; add a `UNIQUE` constraint + index on `dedup_key` in the
      `transactions` schema. Not one formula for all banks — SEB provides a
      provider transaction ID (use directly), Revolut/monobank unconfirmed and
      likely need a content-hash fallback; resolve per bank when writing that
      parser, not here.
- [ ] Implement the ingestion Lambda: SQS trigger (batch size 1), bank/owner
      resolution (S3 key for CSV, `From:`/recipient allowlist match for email),
      per-bank parser dispatch, single Data API transaction per file with
      `ON CONFLICT (dedup_key) DO NOTHING` writes.
- [ ] Issue the presigned-PUT endpoint on the primary app API (ADR-0001/0002
      REST API + Cognito authorizer), scoped to `uploads/{sub}/{bank}/*`, `sub`
      taken only from the authorizer claim.
- [ ] Write per-bank parser test fixtures (real anonymized sample statements) to
      validate dedup-key normalization catches true duplicates without
      over-merging distinct transactions.
- [ ] Revisit standard-vs-FIFO if a future requirement makes processing order
      itself user-visible (e.g., a running-balance computation that must apply
      transactions in strict sequence rather than as an unordered set) — not
      needed for dedup as designed, but a different feature could reintroduce it.
