## Why

The `bot-retention` schedule runs every hour (`rate(1 hour)` in `infra/lib/bot.ts`), and every run resumes the Aurora cluster. The cluster has min 0 ACU and pauses after 300 s idle (`infra/lib/aurora.ts`). So even with no traffic at all, it is awake for a noticeable share of every hour. Running the sweep every 12 hours cuts the forced wake-ups from 24 a day to 2. That only works if the two time windows that assume an hourly run are widened to match.

## What Changes

- The retention schedule becomes the Pulumi config value `draupnir-infra:retentionSchedule`, with the default `rate(12 hours)`. Deploys refuse a value that is not a `rate(...)` expression or whose period is longer than 13 hours (see design.md, Decision 3).
- **BREAKING (user-visible timing)**: bot messages that carry financial data become eligible for deletion after **20 hours**, down from 24. Each is deleted 20–32 hours after it was sent, and before 48 hours even if one scheduled run is missed or fails. Users previously saw roughly 24–25 hours.
- Outcomes that were published but never reported (the queue gave up on them, migration 0016) are republished for **48 hours** after commit, up from 24. The 12-hourly run then gets at least 3 attempts, or at least 2 when one run is missed.
- A new migration replaces `claim_due_bot_messages` and `unreported_outcomes` with the new intervals. Migrations 0015 and 0016 are frozen.
- Outcomes that were never published, or never reported, are also swept by the bot worker after it handles user traffic. Aurora is already awake then, so a missed report arrives within minutes once anyone uses the bot. While the bot is idle it may wait up to 12 hours for the scheduled run. Design.md accepts this and does not add an inline retry.
- Comments in `infra/lib/bot.ts`, `infra/lib/botQueues.ts`, `bot/src/retention.ts` and `bot/src/lib/outcomes/reportOutcome.ts` are updated, as are `docs/telegram-bot.md`, `docs/data-model.md` and `docs/architecture.md`, and the tests that pin the thresholds.

Non-goal: replacing EventBridge Scheduler.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `telegram-message-retention`: the deletion window changes from "24 to 48 hours" to "no earlier than 20 hours, and always before 48 hours, even after one missed or failed run". A new requirement says the run's schedule is configurable only within that guarantee.

## Impact

- **Infra**: `infra/lib/bot.ts` (config read, validation, schedule), `infra/lib/botQueues.ts` (comment), `infra/src/bot.spec.ts`.
- **Database**: new migration `0019` that changes two SECURITY DEFINER functions. No table or data changes.
- **Bot / shared**: the outcome-sweep helper moves from `bot/src/retention.ts` to `bot/src/lib/outcomes/` and is also called by `bot/src/worker.ts` after update batches (throttled). The worker gets `sqs:SendMessage` on the outcomes queue and `OUTCOME_QUEUE_URL`. Comments in `bot/src/retention.ts` and `reportOutcome.ts`. Tests in `bot/src/lib/retention/retention.spec.ts` and `shared/src/lib/outcomes/outbox.spec.ts`.
- **Docs**: `docs/telegram-bot.md` (user guide, reset section, troubleshooting), `docs/data-model.md`, `docs/architecture.md`.
- **Cost**: Aurora is no longer resumed once an hour on an idle system, only twice a day.
- **Users**: bot messages disappear a little earlier (from 20 h instead of 24 h). A failed outcome report may arrive up to about 12 h later than before while the bot is idle, and within minutes once the user sends anything.
