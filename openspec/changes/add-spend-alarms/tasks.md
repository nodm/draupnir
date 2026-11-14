## 1. Config parser and queue retention

- [x] 1.1 Create `infra/lib/alerts.ts` with `BUDGET_CONFIG_KEY = 'draupnir-infra:budgetMonthlyUsd'`, `DEFAULT_BUDGET_MONTHLY_USD = 20` and `budgetMonthlyUsd(value)`, following design Decision 2: unset or blank gives 20; any value that is not a finite number greater than 0 throws, with the key in the message. Add unit tests in `infra/src/alerts.spec.ts` for undefined → 20, `'12.5'` → 12.5, and `'0'`, `'-5'`, `'abc'`, `'Infinity'` throwing with `draupnir-infra:budgetMonthlyUsd`. Verify with `pnpm exec nx test infra`.
- [x] 1.2 Add `INGESTION_QUEUE_RETENTION_DAYS = 14` to `infra/lib/uploadRetention.ts`, with a comment on how it interacts with the DLQ (design Decision 6). Set `messageRetentionSeconds` on the `ingestion` queue in `infra/lib/ingestionPipeline.ts`. Verify that the existing infra tests pass.

## 2. Alert resources

- [x] 2.1 In `alerts.ts`, add `createAlerts(provider, { deadLetterQueues, ingestionQueue })`. It creates the `draupnir-<stack>-alerts` SNS topic and an `email` subscription to `config.requireSecret('alertEmail')` (design Decision 1). Verify with `pnpm exec nx run infra:typecheck`, or with the build target if `pnpm exec nx show project infra` lists no typecheck target.
- [x] 2.2 Add the account-wide `aws.budgets.Budget` `draupnir-<stack>-monthly`: COST, MONTHLY, USD, `limitAmount` from `budgetMonthlyUsd`, no cost filters. Give it three notifications (ACTUAL 100 %, ACTUAL 250 %, FORECASTED 100 %), each with `subscriberEmailAddresses: [alertEmail]` (design Decision 2). Verify with the typecheck from 2.1.
- [x] 2.3 Add the anomaly monitor and subscription (design Decision 3). Read the optional `anomalyMonitorArn` config. Create a DIMENSIONAL/SERVICE `aws.costexplorer.AnomalyMonitor` only when that key is unset. Create the `AnomalySubscription` with DAILY frequency, an EMAIL subscriber and the threshold `ANOMALY_TOTAL_IMPACT_ABSOLUTE >= 5`. Verify with the typecheck from 2.1.
- [x] 2.4 Add the four `aws.cloudwatch.MetricAlarm`s (design Decisions 4–5): one `ApproximateNumberOfMessagesVisible > 0` alarm per DLQ (`ingestion-dlq`, `bot-updates-dlq`, `bot-outcomes-dlq`), and `ApproximateAgeOfOldestMessage > 3600` on `ingestion`. All use `Maximum`, a 300 s period, 1 evaluation period, `treatMissingData: notBreaching`, `alarmActions: [topic]` and no `okActions`. Name them `draupnir-<stack>-<queue>-…`, and give each an `alarmDescription` that names the queue's purpose and points to the README Alerts section. Verify with the typecheck from 2.1.
- [x] 2.5 Call `createAlerts` from `infra/index.ts` with the three DLQs and the ingestion queue, and export `alertsTopicArn`. Verify that `pnpm exec nx test infra` still runs; the guardrail tests will fail on the missing `alertEmail` until 3.1.

## 3. Guardrail tests

- [x] 3.1 Add `'draupnir-infra:alertEmail'` to the mock config in `infra/src/guardrails.spec.ts` (`bot.spec.ts` builds only `createBot`, so it needs no change). Extend `guardrails.spec.ts` with assertions on the budget, the created monitor and its subscription, the four alarms (metric, threshold, `treatMissingData`, `QueueName`, action, no `okActions`) and the `ingestion` queue's `messageRetentionSeconds` of 1209600 (design Decision 8). Update the header comment. Verify with `pnpm exec nx test infra`.
- [x] 3.2 Add a separate spec file that runs the program with `anomalyMonitorArn` and `budgetMonthlyUsd: '40'` set. Assert that no `AnomalyMonitor` is recorded, that the subscription uses the given ARN, and that the budget limit is `'40'`. In the same file, or a third one, assert that a run without `alertEmail` rejects with an error naming `draupnir-infra:alertEmail`. Verify with `pnpm exec nx test infra`.
- [x] 3.3 Temporarily remove the DLQ alarm for `bot-outcomes-dlq` and confirm that the test from 3.1 fails, then revert. Verify by noting the failing assertion in the PR description.

## 4. Documentation

- [x] 4.1 In `infra/README.md`:
  - Add an "Alerts" section after "Upload retention". It covers `alertEmail` (required, secret), `budgetMonthlyUsd` (default 20, account-wide, emails at 100 %/250 % actual and 100 % forecast), `anomalyMonitorArn` (how to find an existing monitor and when to set it), the one-time email confirmation, the `set-alarm-state` test command, and a table of the four alarms. For each alarm the table gives what it means and the first command to inspect it, for example `aws sqs get-queue-attributes --queue-url "$(pulumi stack output ingestionDlqUrl)" --attribute-names ApproximateNumberOfMessages`.
  - Add `alertEmail` to "Required stack config", and the two optional keys next to `logRetentionDays`/`uploadRetentionDays`.

  Verify with `pnpm exec prettier --check infra/README.md`.
- [x] 4.2 In `docs/architecture.md`, add the alert resources to the Notes (budget, anomaly monitor, SNS topic, four alarms) and mention the 14-day retention of the ingestion queue. Verify that the mermaid block still parses: keep the existing node ids, or add none.
- [x] 4.3 Run `pnpm exec openspec validate add-spend-alarms --strict` and confirm that it passes.

## 5. Full checks

- [x] 5.1 Run `pnpm exec nx run-many -t lint test typecheck -p infra` (using the targets that exist) and confirm that everything passes.

## 6. Deploy (manual, by the maintainer, before the PR is opened)

- [x] 6.1 Check last month's bill and decide `budgetMonthlyUsd`. Check Cost Anomaly Detection for an existing services monitor and set `anomalyMonitorArn` if there is one. Run `pulumi config set --secret alertEmail "<address>"`. Verify with `pulumi config` that the keys are listed, with `alertEmail` shown as `[secret]`.
- [x] 6.2 Look at all three DLQs (`ApproximateNumberOfMessages`) so that an alarm on the first deploy is expected. Run `pnpm exec nx run infra:preview` and confirm only creates plus the in-place `ingestion` queue update, with no replacements. If the budget or Cost Explorer resources fail on the regional provider, apply the `us-east-1` provider fallback from the design's Risks section. Then run `pnpm exec nx run infra:up`.
- [ ] 6.3 Confirm the SNS subscription from the email. Run `aws cloudwatch set-alarm-state --alarm-name draupnir-prod-ingestion-dlq-messages --state-value ALARM --state-reason test` and confirm that the alarm email arrives. Check in the Budgets console that `draupnir-prod-monthly` exists with three alerts.
