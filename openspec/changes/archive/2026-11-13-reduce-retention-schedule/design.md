## Context

See proposal.md (Why). The single scheduled `bot-retention` Lambda does three jobs, and the timing of each one was chosen for an hourly run:

| Job | Where | Interval baked in | Assumes hourly because… |
| --- | --- | --- | --- |
| Delete recorded bot messages (and uploaded statements whose immediate delete failed) | `claim_due_bot_messages` (migration 0015) | `sent_at < now() - 24 h` | 24 h + one 1 h period ≤ 25 h, far below Telegram's 48 h `deleteMessage` limit |
| Publish outbox rows never published (`publishDueOutcomes`) | `due_outcomes` (0009) | `created_at < now() - 1 min`, no upper bound | delivered "within the hour" |
| Republish outcomes published but never reported (`republishUnreportedOutcomes`) | `unreported_outcomes` (0016) | `published_at < now() - 1 h` and `created_at > now() - 24 h` | "once an hour, for a day", so about 23 attempts |

Other constraints:

- The schedule has `retryPolicy.maximumRetryAttempts: 0` and `flexibleTimeWindow: OFF`. A run that fails is simply missed. The next try is the next scheduled run.
- One run deletes at most 2000 messages (`MAX_BATCHES × BATCH`) within a 600 s timeout. Claims hold a 15-minute lease.
- The outcomes queue moves a message to its DLQ after 5 receives with a 540 s visibility timeout, about 45 minutes after the first publish.
- The ingestion Lambda also runs `publishDueOutcomes` after every batch (`ingestion/src/handler.ts`). Unpublished rows therefore have a second sweeper that runs whenever anyone uploads.
- Migrations are FROZEN once applied, so the intervals change in a new migration.

## Goals / Non-Goals

**Goals:**

- Default to `rate(12 hours)`, configurable through `draupnir-infra:retentionSchedule`.
- Every recorded message is deleted before 48 h, even when one run in a row is missed or fails.
- Every unreported outcome gets at least 2 republish attempts, also when one run is missed.
- Bad schedule values fail at deploy time, not silently at 48 h.

**Non-Goals:**

- Replacing EventBridge Scheduler, or splitting the job into separate schedules.
- Changing the retry policy (still 0 retries), the per-run batch cap or the claim lease.
- Retrying deletions that Telegram refused (still one try per message).

## Decisions

### 1. Deletion threshold: 24 h → 20 h

Let T be the age at which a message becomes due and P the schedule period. A message is deleted by the first run at or after `sent + T`:

- every run succeeds: deleted in `[T, T + P)`
- the first eligible run is missed or fails: deleted before `T + 2P`
- plus the run's own duration, at most 600 s

The goal is `T + 2P + 10 min < 48 h`. With P = 12 h:

| T | Normal | One missed run | Margin to 48 h |
| --- | --- | --- | --- |
| 24 h (today) | 24–36 h | **< 48 h + 10 min: fails** | none |
| 22 h | 22–34 h | < 46 h 10 min | 1 h 50 min |
| **20 h** | **20–32 h** | **< 44 h 10 min** | **3 h 50 min** |

24 h does not work: with one missed run the message reaches 48 h exactly as the next run starts. 20 h is the largest round value that leaves a margin of several hours. That margin also covers the 13 h cap in Decision 3 (`20 + 26 = 46 h`). It covers an overflow beyond 2000 due messages too: the overflow rolls to the next run, which is the same as one missed run for those messages. A lower T, such as 12 h, would delete messages users may still want to look at, and buys nothing the margin does not already give.

Alternative: derive T from the configured schedule and pass it to the function (`claim_due_bot_messages(limit, min_age)`). Rejected. It adds a parameter, a Lambda environment variable and a signature change across a frozen migration. In return it only buys deletion closer to 24 h, which is not a goal. A fixed T plus the deploy-time check (Decision 3) keeps the guarantee in one place.

`due_bot_messages` (0009, superseded and unused by code) keeps 24 h. It only appears in a schema test, and changing it would imply that it is still in use.

### 2. Unreported-outcome window: 24 h → 48 h

An outcome committed at `c` lands in the DLQ by about `c + 45 min`. The 1 h guard on `published_at` (so a live worker is not overlapped) makes it eligible from `c + 1 h`. Each republish refreshes `published_at`, and the next run is P later, so it is eligible again. The runs inside `(c + 1 h, c + W)` number at least `⌊(W − 1 h) / P⌋`:

| W | P = 12 h | P = 12 h, one run missed | P = 13 h (cap), one missed |
| --- | --- | --- | --- |
| 24 h (today) | **1** | **0** | 0 |
| 36 h | 2 | **1** | 1 |
| **48 h** | **3** | **2** | **2** |

48 h is the smallest round window that keeps ≥ 2 attempts under the same "one missed run" assumption used for deletion. Going longer has little value. A report that arrives two days late is barely useful, and a poison outcome that will never report should stop. With a shorter configured schedule the attempts grow (about 47 at hourly), which is still bounded.

The 1 h `published_at` guard stays. It protects a worker that is still processing, and it does not depend on the schedule.

### 3. Schedule is config, validated at deploy

`infra/lib/bot.ts` reads `config.get('retentionSchedule') ?? 'rate(12 hours)'` and passes it through a pure function, `retentionScheduleExpression(value)`, exported for tests. The function:

- accepts only `rate(<n> minute|minutes|hour|hours|day|days)` with a positive integer n
- computes the period and throws if it is longer than `MAX_RETENTION_PERIOD_HOURS = 13`. The cap is derived next to the constants: `(TELEGRAM_DELETE_LIMIT_HOURS 48 − DELETE_AFTER_HOURS 20 − SAFETY_HOURS 2) / 2`
- rejects `cron(...)` and `at(...)`, because a cron's longest gap cannot be checked without a cron engine, and the requirement is a guarantee

A thrown error fails `pulumi preview`/`up` before any resource changes. The error names `draupnir-infra:retentionSchedule` and the 13 h cap. `DELETE_AFTER_HOURS` repeats the 20 h from migration 0019. A comment on each side points to the other, because infra does not depend on `shared`.

There is no lower bound. A short period only costs more Aurora wake-ups, and overlapping runs are already safe because of the claim leases.

Alternative: accept any expression and document the constraint. Rejected. A typo such as `rate(1 day)` would quietly break the 48 h deletion guarantee.

### 4. Open question settled: up to 12 h late is acceptable when idle, no inline retry

Two paths can now be up to about 12 h late:

- **Never published** (the publish right after commit failed). The AWS SDK v3 already retries the `SendMessage` call (standard mode, 3 attempts with backoff). The only failures left are an SQS outage that outlasts those retries, or the Lambda dying between commit and publish. A longer inline retry would not help a dead Lambda, and against an outage it would hold one of the 2 capped ingestion concurrency slots for minutes. Also, the next upload's ingestion batch runs `publishDueOutcomes`, so a user who keeps uploading gets the report much sooner than 12 h.
- **Published but never reported** (DLQ). The worker has already failed 5 times over about 45 minutes, so the cause is very likely persistent (a Telegram outage, a bug, or the user blocked the bot). Retrying within the hour rarely succeeds where 5 tries did not. The DLQ remains the operator's tool, through the troubleshooting doc's "redrive" path.

In both cases the statement is already imported and visible (account coverage in the bot, MCP tools). Only the chat notification is late. Both paths are rare failure modes, and paying 22 extra Aurora wake-ups a day to shorten them is the cost this change removes. **Decision: accept up to about 12 h of delay while nobody uses the bot. Do not add an inline retry. Shorten the delay for free whenever the bot has traffic (Decision 6).**

Options considered:

| Option | Verdict |
| --- | --- |
| Accept up to 12 h delay | Chosen as the baseline |
| Longer inline retry in ingestion | Rejected: does not help a Lambda that died mid-publish, and holds an ingestion slot during an SQS outage |
| Sweep from the bot worker on user traffic | **Chosen as well (Decision 6)**: Aurora is already awake, so it costs nothing extra |
| Worker backoff on the outcomes queue (`ChangeMessageVisibility` plus a higher `maxReceiveCount`), so failing reports retry over hours instead of reaching the DLQ in about 45 min | Follow-up if DLQ arrivals turn out to happen in practice. It touches worker failure handling and the 2-minute report lease reasoning (Context) |
| Lambda on the outcomes DLQ that redrives with a delay | Rejected: a new component that does what the backoff option does with more parts |
| Shorter default schedule (e.g. 6 h) | Not chosen. Already possible through `retentionSchedule` if needed |
| Separate, frequent schedule just for outcomes | Rejected: the outbox lives in Aurora, so it wakes Aurora as often as today |

### 6. The bot worker also sweeps outcomes after handling user traffic

When the worker has handled a batch from the **updates** queue (a person used the bot), it also runs the same two sweeps as the scheduled run: `publishDueOutcomes`, then `republishUnreportedOutcomes`. Aurora is already awake for that batch, so this adds two cheap queries and no wake-up. A user who sends any message after a missed report gets it within minutes instead of waiting for the next 12-hourly run.

- **Shared code**: the scheduled run's `republishOutcomes` helper (`bot/src/retention.ts`) moves to `bot/src/lib/outcomes/`, and both handlers call it. Failures are logged (`outcome-sweep-failed`, `outcome-reconcile-failed`) and never thrown.
- **Never affects the batch**: it runs after every record has been processed and the `batchItemFailures` list is built. A sweep failure or slowness cannot fail or reorder an update. It is skipped when the batch had a failure, because the chat is already struggling.
- **Not on outcome batches**: it does not run after a batch from the outcomes queue. That avoids a worker republishing outcomes as a side effect of processing outcomes. The 1 h `published_at` guard already prevents a tight loop, but this keeps the paths easy to reason about.
- **Throttled per warm container**: at most once every 10 minutes (a module-level timestamp), so a busy chat does not add two queries to every update. This is best effort, and cold containers reset the timestamp.
- **Infra**: the worker role gets `sqs:SendMessage` on the outcomes queue, and the worker gets `OUTCOME_QUEUE_URL`. Without the variable the sweep is skipped, the same as in the scheduled run.
- **Duplicates are safe**: a scheduled run and a worker sweep can publish the same outcome. Reporting is already idempotent (`claim_outcome_report`), and consumers tolerate duplicates (statement-ingestion-pipeline spec).

### 5. Migration 0019

`0019-sparse-retention-schedule` runs `CREATE OR REPLACE FUNCTION` on `draupnir.claim_due_bot_messages(integer)` (20 h) and `draupnir.unreported_outcomes(integer)` (48 h). Signatures, `SECURITY DEFINER`, `search_path` and bodies stay otherwise identical. `CREATE OR REPLACE` keeps owner and grants. The REVOKE/GRANT pair is repeated anyway so the migration states its intended privileges on its own. It is registered in `migrations.ts`, and the frozen-file comments in 0015 and 0016 stay as they are.

## Risks / Trade-offs

- [Messages disappear 4 h earlier than users were told] → Update the user guide in `docs/telegram-bot.md` ("about 20 to 32 hours later").
- [On first deploy every message 20–24 h old becomes due at once] → At most 2000 per run, and the rest go on the next run. The backlog is small for a personal bot.
- [Two missed runs in a row (24 h of failures) let messages pass 48 h] → Same class of risk as before at a longer time scale. Each such message is marked failed and logged (`retention-delete-failed`), as already specified. A single failed run is now visible for 12 h, so it should be checked in the logs.
- [`DELETE_AFTER_HOURS` in infra drifts from the SQL interval] → Cross-reference comments on both sides. Tests on each side pin their own value (infra cap test, retention 19 h/21 h tests).
- [Up to about 12 h late outcome reports while the bot is idle] → Accepted (Decision 4). Any use of the bot triggers the sweep (Decision 6). Documented in troubleshooting ("send any message to the bot to retry").
- [The worker sweep adds latency to update batches] → It runs after the batch's replies are sent, at most once every 10 minutes per container, and only two indexed queries plus at most 25 publishes each.

## Migration Plan

1. Deploy as one `infra:up`. Migrations run before the Lambdas that depend on them (`afterMigrations`), so the 20 h/48 h functions are live before the schedule changes.
2. No config change is needed for the default. To override, run `pulumi config set draupnir-infra:retentionSchedule 'rate(6 hours)'`.
3. Rollback: `pulumi config set draupnir-infra:retentionSchedule 'rate(1 hour)'` and `infra:up`. 20 h/48 h are safe at any shorter period, so the migration does not need reverting. If the old intervals are really wanted, a later forward migration restores them.
