## 1. Database intervals (migration 0019)

- [x] 1.1 Add `shared/src/lib/migrations/0019-sparse-retention-schedule.ts`. It runs `CREATE OR REPLACE` on `draupnir.claim_due_bot_messages(integer)` with `interval '20 hours'` and on `draupnir.unreported_outcomes(integer)` with `created_at > now() - interval '48 hours'`. Bodies, `SECURITY DEFINER`, `search_path` and the REVOKE/GRANT pair stay the same as 0015/0016. Add a FROZEN header comment that explains the 12-hourly arithmetic (design Decisions 1, 2) and refers to `DELETE_AFTER_HOURS` in `infra/lib/bot.ts`. Register it in `migrations.ts`. Verify with `pnpm nx test shared` (the migration-order and runMigrations specs pass).
- [x] 1.2 Update the retention tests in `bot/src/lib/retention/retention.spec.ts`: a message sent 21 h ago is deleted, a message sent 19 h ago is left, and the test names say 20 hours. Add a case where a message aged 44 h (one missed 12 h run) is still claimed and deleted. Verify with `pnpm nx test bot`.
- [x] 1.3 Update the `republishUnreportedOutcomes` tests in `shared/src/lib/outcomes/outbox.spec.ts`. Rename "once an hour" to "not again within the hour". Replace "gives up after a day" with: still republished at 47 h, given up at 49 h. Add a case that simulates 12-hourly runs (age the outbox row and `published_at` between calls) and asserts at least 2 republishes before giving up. Verify with `pnpm nx test shared`.

## 2. Infra schedule config

- [x] 2.1 In `infra/lib/bot.ts`, replace `RETENTION_SCHEDULE` with `config.get('retentionSchedule') ?? 'rate(12 hours)'`. Validate it with an exported pure `retentionScheduleExpression(value)`, which accepts only `rate(n minute(s)|hour(s)|day(s))` with a period ≤ `MAX_RETENTION_PERIOD_HOURS` (13, derived from `TELEGRAM_DELETE_LIMIT_HOURS`, `DELETE_AFTER_HOURS`, `SAFETY_HOURS`). Throw an error naming `draupnir-infra:retentionSchedule` otherwise. Rewrite the schedule comment to describe the 20–32 h normal and < 44 h worst-case window, and the 48 h republish window. Verify with `pnpm nx run infra:typecheck` (or the project's build/lint target).
- [x] 2.2 In `infra/src/bot.spec.ts`, change "runs every hour" to "runs every 12 hours by default" (`rate(12 hours)`, flexible window OFF, 0 retries). Add unit tests for `retentionScheduleExpression`: it accepts `rate(1 hour)`, `rate(6 hours)` and `rate(13 hours)`; it rejects `rate(14 hours)`, `rate(1 day)`, `cron(0 */12 * * ? *)`, `at(2026-01-01T00:00:00)` and `rate(0 hours)`, each with the config key in the message. Add a test that a configured override reaches the schedule if the spec's Pulumi mocks support setting config, otherwise cover it through the pure function only. Verify with `pnpm nx test infra`.
- [x] 2.3 Update the `OUTCOMES_MAX_RECEIVE_COUNT` comment in `infra/lib/botQueues.ts` ("every scheduled run, 12-hourly by default, for 48 hours: at least 2 attempts even after a missed run"). Verify by reading the diff.

## 3. Worker sweeps outcomes on user traffic

- [x] 3.1 Move `republishOutcomes` from `bot/src/retention.ts` into `bot/src/lib/outcomes/` (for example `sweepOutcomes.ts`) and have the retention handler import it. Verify that the existing retention handler behaviour is unchanged (`pnpm nx test bot`).
- [x] 3.2 In `bot/src/worker.ts`, after an updates-queue batch with no failures, call the sweep when `OUTCOME_QUEUE_URL` is set and no sweep ran in this container in the last 10 minutes. Never throw, and never change `batchItemFailures`. Add tests in `worker.spec.ts`. The sweep runs after a successful update batch. It is skipped after an outcome batch, after a batch with a failure, within 10 minutes of the previous sweep, and without `OUTCOME_QUEUE_URL`. A sweep that rejects leaves the batch result unchanged. Verify with `pnpm nx test bot`.
- [x] 3.3 In `infra/lib/bot.ts`, give the `bot-worker` role `sqs:SendMessage` on `queues.outcomes.arn` and the worker function `OUTCOME_QUEUE_URL`. Extend `infra/src/bot.spec.ts` to assert both, and that the webhook and callback roles still cannot send to the outcomes queue. Verify with `pnpm nx test infra`.

## 4. Code comments

- [x] 4.1 Update the handler comment in `bot/src/retention.ts` ("every 12 hours by default; deletes messages older than 20 hours…"), the "24-48 hours" comment in `bot/src/lib/outcomes/reportOutcome.ts`, and the "after a minute" sweeper wording in `shared/src/lib/outcomes/outbox.ts` (now at the next upload or the next scheduled run). Verify that `grep -rn -i "hourly\|every hour\|24-48\|within the hour" bot/src shared/src infra/lib` returns no stale hits, apart from the frozen 0015/0016 comments.

## 5. Docs

- [x] 5.1 Update `docs/telegram-bot.md`. In the user guide, say deleted "about 20 to 32 hours later, always before Telegram's 48-hour limit". In the reset section, replace "hourly run" with "scheduled run". Change the statement-deletion paragraph to "within 20 to 32 hours". In troubleshooting, change the entry to "the scheduled run republishes unreported outcomes every 12 hours for two days, and any message to the bot also triggers a retry; while the bot is idle a report can arrive up to about 12 h late". Add an operator note on `pulumi config set draupnir-infra:retentionSchedule` and its 13 h cap. Verify by reading the rendered sections.
- [x] 5.2 Update `docs/data-model.md` (`claim_due_bot_messages`: older than 20 hours; `unreported_outcomes`: within 48 hours) and `docs/architecture.md` (`bot-retention` "every 12 h (config), no retries"; the worker also sweeps outcomes). Verify that `pnpm nx format:check` passes on the changed docs.

## 6. Verification

- [x] 6.1 Run `pnpm nx run-many -t lint test typecheck -p infra bot shared ingestion` and confirm everything passes.
- [x] 6.2 Run `pulumi preview` on the stack (through the infra preview target) and confirm the only resource diffs are the `bot-retention` schedule expression (`rate(1 hour)` → `rate(12 hours)`), the worker's new policy statement and environment variable, and the Lambda code updates. Then set `retentionSchedule` to `rate(1 day)` and confirm the preview fails with the cap error before any changes. Unset it again afterwards.
- [x] 6.3 Run `pnpm exec openspec validate reduce-retention-schedule --strict` and confirm it passes.
