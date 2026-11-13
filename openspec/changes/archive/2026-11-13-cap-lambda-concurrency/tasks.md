## 1. Quota check

- [x] 1.1 Run `aws lambda get-account-settings --region eu-north-1` and record the result in `design.md` (done 2026-11-13: `ConcurrentExecutions` 10, `UnreservedConcurrentExecutions` 10)
- [x] 1.2 Decide the branch (done: quota 10 cannot support reservations; scope shrunk to SQS caps, see proposal.md)

## 2. Cap the mappings

- [x] 2.1 Add `infra/lib/concurrencyLimits.ts` exporting `QUEUE_MAX_CONCURRENCY = 2` with a comment pointing to `design.md` decision 2; verify the file exists and `pnpm exec nx run infra:build` passes
- [x] 2.2 `infra/lib/bot.ts`: add `scalingConfig: { maximumConcurrency: QUEUE_MAX_CONCURRENCY }` to both worker mappings in the loop, with a comment that the cap is per mapping; leave `batchSize: 1` and `ReportBatchItemFailures` as they are; verify with a recorded-resource assertion in `infra/src/bot.spec.ts` for `bot-updates` and `bot-outcomes`
- [x] 2.3 `infra/lib/ingestionPipeline.ts`: add the same `scalingConfig` to the `ingest` mapping; verify with a mock spec that the recorded mapping has `maximumConcurrency` 2
- [x] 2.4 Add an offline assertion that no `aws:lambda/function:Function` is recorded with `reservedConcurrentExecutions` (reservations are deliberately not used while the quota is 10); verify `pnpm exec nx run infra:test` passes
- [x] 2.5 Re-check `infra/lib/botQueues.ts` against design decision 3 (visibility timeout 540 s vs worker timeout 90 s, DLQ counts, FIFO group = chat id); verify no queue setting needs changing, or record in `design.md` what did

## 3. Docs and validation

- [x] 3.1 `docs/architecture.md`: add a short "Concurrency" note with the quota (10), the date read (2026-11-13), the `aws lambda get-account-settings --region eu-north-1` re-check command, that it is an AWS setting, the queue cap (up to 6 of 10; worker up to 4), and "if it changes, revisit the cap and the deferred reservations (need quota ≥ 27)"; verify the Mermaid diagram still renders and format/lint passes
- [x] 3.2 Run `pnpm exec openspec validate cap-lambda-concurrency --strict` and `pnpm exec nx affected -t lint test build`; verify both are green

## 4. Rollout

- [x] 4.1 `pnpm exec nx run infra:preview`, verify only the three event source mappings change (in place, none replaced); then `pnpm exec nx run infra:up`
- [x] 4.2 Verify with `aws lambda get-event-source-mapping --uuid <id>` for the three mappings that `ScalingConfig.MaximumConcurrency` is 2
- [x] 4.3 Optional: observe what API Gateway returns when a function is throttled (done with `bot-callback`, since `whoami` is behind the Cognito authorizer and would return 401 without reaching Lambda; set it to reserved concurrency 0 with `aws lambda put-function-concurrency`, call it, record the status in `design.md` decision 4, then `aws lambda delete-function-concurrency`); skip if AWS rejects the 0
- [x] 4.4 Send two quick messages from one Telegram chat and verify the replies arrive in order; verify a statement upload still ends with its outcome message in the chat
