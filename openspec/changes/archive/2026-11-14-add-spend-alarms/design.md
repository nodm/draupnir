## Context

See proposal.md (Why) for the motivation. The current state:

- The program has no `aws.cloudwatch.MetricAlarm`, `aws.sns.*`, `aws.budgets.*` or `aws.costexplorer.*` resources. The only CloudWatch resources are the per-function log groups (`lambdaFunction.ts`).
- There are six SQS queues:
  - `ingestion` and `ingestion-dlq` (`ingestionPipeline.ts`). The DLQ keeps messages for 14 days (`INGESTION_DLQ_RETENTION_DAYS`).
  - `bot-updates` and `bot-updates-dlq`, FIFO (`botQueues.ts`).
  - `bot-outcomes` and `bot-outcomes-dlq` (`botQueues.ts`).

  All three source queues use the SQS default retention of 4 days. `ingestion` has a visibility timeout of 540 s and moves a message to the DLQ after 5 receives. Its event source mapping is capped at 2 concurrent invocations.
- The provider is regional (`eu-north-1`, `provider.ts`). AWS Budgets and Cost Explorer are global services with a `us-east-1` endpoint.
- AWS allows only one Cost Anomaly Detection monitor of type DIMENSIONAL/SERVICE per account. An account may already have one: AWS creates a default services monitor for many accounts, and it may also have been set up by hand.
- Config parsing follows a set pattern: `logRetention.ts`, `uploadRetention.ts` and `retentionSchedule.ts` each export a parser that throws, naming its key, so a bad value fails `pulumi preview`. The guardrails are pinned by program-wide mock tests in `infra/src/guardrails.spec.ts`.
- The repository is public. Personal data such as an email address must live only in encrypted stack config.

## Goals / Non-Goals

**Goals:**

- One recipient hears about high spend, cost anomalies, dead-lettered messages and an ingestion backlog, with no alert noise in normal operation.
- Everything is in the stack, validated at preview, and pinned by tests.
- The ingestion queue never drops an upload because a backlog outlasted the queue's retention.

**Non-Goals:**

- An automatic kill switch that throttles APIs to 0 when spend crosses a threshold (a budget action, or an alarm that drives a Lambda). This change only notifies.
- Alarms on API Gateway request counts, Lambda errors or throttles, or Aurora capacity. The budget and the anomaly monitor catch their cost effect, and per-API alarms can be added later.
- Longer retention for `bot-updates` and `bot-outcomes`. A Telegram update older than 4 days is stale. Unreported outcomes are republished for 48 hours by the retention run (migration 0019) and are not lost by queue expiry. Their DLQs are alarmed.
- Slack, SMS or any other channel besides email.

## Decisions

### 1. Two delivery paths: direct email for the budget and anomalies, SNS email for CloudWatch alarms

CloudWatch alarm actions can only target SNS (or Auto Scaling/EC2/Systems Manager), so the alarms publish to an SNS topic, `draupnir-<stack>-alerts`, which has one `email` subscription to `alertEmail`.

The budget and the anomaly subscription email the address directly, instead of also going through the topic:

- **No topic policy for other services.** Publishing a budget or anomaly alert to SNS needs a topic policy that allows `budgets.amazonaws.com` and `costalerts.amazonaws.com`. Anomaly subscriptions that use SNS must also use `IMMEDIATE` frequency, which sends one message per anomaly.
- **No cross-region question.** It is not settled here whether those services publish to a topic in `eu-north-1`. Direct email avoids the question.
- **No confirmation needed.** A budget email works without a subscription confirmation, so the most important alert works even if the SNS confirmation is missed.

Alternative considered: everything through one SNS topic. That gives one path to test, but the topic policy, the frequency constraint and the region question make it more fragile for no gain at this scale.

### 2. Account-wide COST budget with percentage thresholds

`aws.budgets.Budget` named `draupnir-<stack>-monthly`:

- `budgetType: COST`, `timeUnit: MONTHLY`, `limitUnit: USD`.
- `limitAmount` comes from `budgetMonthlyUsd`.
- No cost filters: the question is "what will I pay", and that includes the Pulumi state KMS key, the Route 53 zone and anything else in the account.

There are three notifications, all `PERCENTAGE` thresholds:

| Notification type | Threshold | At the default limit |
|---|---|---|
| ACTUAL | 100 | $20 |
| ACTUAL | 250 | $50 |
| FORECASTED | 100 | $20 |

Percentages keep the three in proportion when the limit is changed with one config value.

Alternative considered: two separate config values, for the warning and the "act now" amount. That is more knobs for a two-user system, and 2.5× the limit is a clear escalation step.

`infra/lib/alerts.ts` exports `budgetMonthlyUsd(value)`:

- Unset or blank → 20.
- Otherwise the value must be a finite number greater than 0. Decimals are allowed, because Budgets accepts them.
- Anything else throws with `draupnir-infra:budgetMonthlyUsd` in the message.

`alertEmail` is read with `config.requireSecret('alertEmail')`. Pulumi then fails the preview with `Missing required configuration variable 'draupnir-infra:alertEmail'`, which names the key as the spec requires. The value stays a secret Output in the state and the resource inputs.

### 3. Anomaly monitor: create one, or reuse the account's by ARN

New optional config key: `draupnir-infra:anomalyMonitorArn`.

- **Unset:** the program creates `aws.costexplorer.AnomalyMonitor` (`monitorType: DIMENSIONAL`, `monitorDimension: SERVICE`).
- **Set:** no monitor is created, and the subscription uses that ARN.

In both cases, one `aws.costexplorer.AnomalySubscription` is created with these settings:

- `frequency: DAILY`.
- An `EMAIL` subscriber with `alertEmail`.
- `thresholdExpression`: `ANOMALY_TOTAL_IMPACT_ABSOLUTE` `GREATER_THAN_OR_EQUAL` `5`. That is $5, low enough to catch a small runaway early, and a fixed constant.

Alternative considered: `pulumi import` the existing monitor. The stack would then own an account-level resource that may predate it, and `pulumi destroy` would delete it. Reusing it by ARN leaves ownership where it was.

Before deploying, the maintainer checks for an existing monitor in the console (Billing and Cost Management → Cost Anomaly Detection → Cost monitors). If one exists, they set its ARN. Otherwise the create fails on the per-account limit, and the error is clear enough to recover from.

### 4. Dead-letter alarms: `ApproximateNumberOfMessagesVisible` > 0, alarm action only

There is one `aws.cloudwatch.MetricAlarm` per DLQ:

- Namespace `AWS/SQS`, metric `ApproximateNumberOfMessagesVisible`.
- Dimension `QueueName` = the queue's `name` output.
- Statistic `Maximum`, `period: 300`, `evaluationPeriods: 1`.
- Comparison `GreaterThanThreshold`, `threshold: 0`.
- `treatMissingData: notBreaching`.

Each alarm also has an `alarmDescription` that names the queue's purpose and points at the README Alerts section. `alarmActions` is the topic.

- **No `okActions`.** SQS stops publishing metrics for a queue after about 6 hours without activity. Missing data is treated as not breaching, so a DLQ that still holds a message would later go back to OK. An "OK" email at that point would be wrong. The alarm email marks the arrival, and the README tells the maintainer to check the queue.
- **5-minute period.** The detection time stays within the spec's 10 minutes (one period plus metric delay), and there are no extra charges for high-resolution metrics.

### 5. Ingestion backlog: `ApproximateAgeOfOldestMessage` > 3600 s

The alarm uses the same shape as Decision 4 on the `ingestion` queue: metric `ApproximateAgeOfOldestMessage`, `Maximum`, `period: 300`, `evaluationPeriods: 1`, `GreaterThanThreshold` `3600`, `treatMissingData: notBreaching`, and an alarm action only.

**Why 1 hour.** A file that keeps failing is received 5 times, with up to 540 s of visibility timeout between receives. It reaches the DLQ after at most 4 × 540 s plus 5 × 90 s of processing, which is about 44 minutes, below the threshold. SQS also stops counting a message in this metric once it has been received 3 times, so a poison message cannot keep the age high. That case is the DLQ alarm's job.

A legitimate bulk upload (dozens of files, drained 2 at a time) clears in minutes. A backlog that keeps the oldest message waiting past an hour means processing is stuck or swamped, which is exactly the situation the spending caps hide.

Alternative considered: `ApproximateNumberOfMessagesVisible` above some count. A count threshold depends on how much a normal batch is, and age measures the actual symptom, which is a delay the user notices.

### 6. Ingestion queue retention: 14 days

`messageRetentionSeconds: 14 * 24 * 60 * 60` on the `ingestion` queue, the SQS maximum. It is exported as `INGESTION_QUEUE_RETENTION_DAYS` next to `INGESTION_DLQ_RETENTION_DAYS` in `uploadRetention.ts`. The in-place queue update keeps messages that are already in the queue.

Interaction with the DLQ: for a standard queue, a dead-lettered message keeps its original enqueue time. So a message that waited N days before failing has 14 − N days left in the DLQ. On the normal path N is under an hour, so nothing changes. After a long backlog the window is shorter, but the DLQ alarm fires on arrival.

The upload-retention invariant (uploads are kept for more than 14 days, enforced by `uploadRetentionDays`) still holds, because no message lives longer than 14 days in either queue.

### 7. One module, wired last

`infra/lib/alerts.ts` exports `createAlerts(provider, { deadLetterQueues, ingestionQueue })` and the config parser. `infra/index.ts` calls it after the pipeline and the bot queues exist, and exports `alertsTopicArn`. The stack output gives a handle for testing the topic (`aws sns publish`).

Alarm and topic names are prefixed with `draupnir-<stack>-`, so two stacks in one account cannot collide.

### 8. Tests

`guardrails.spec.ts` extends the default-config program run. It asserts:

- the budget inputs: COST, MONTHLY, `limitAmount` `'20'`, no cost filters, and the three notifications from Decision 2;
- one created anomaly monitor (SERVICE) and one subscription (DAILY, $5);
- four alarms with the metric, threshold, `treatMissingData`, `QueueName` and action from Decisions 4–5, one per DLQ plus the ingestion age alarm, and no `okActions`;
- the `ingestion` queue's `messageRetentionSeconds` = 1209600.

A separate spec file runs the program with `anomalyMonitorArn` and `budgetMonthlyUsd: '40'` set. It asserts that no monitor is created, that the subscription uses the given ARN, and that the limit is `'40'`. A separate file is needed because `setAllConfig` is process-wide per file.

Parser unit tests cover: unset → 20, `'12.5'` → 12.5, and `'0'`, `'-5'`, `'abc'`, `'Infinity'` throw naming the key. A missing `alertEmail` is covered by Pulumi's own required-config error, and a test asserts that the program run rejects without it.

## Risks / Trade-offs

- **[Unconfirmed SNS subscription silences every CloudWatch alarm]** → The migration plan includes the confirmation and an end-to-end test (`aws cloudwatch set-alarm-state`). The budget emails do not depend on it (Decision 1).
- **[Billing data lags by hours; the budget is a backstop, not real-time protection]** → Accepted. The throttles and caps limit the rate; this change makes a sustained rate visible within about a day. A real-time kill switch is a non-goal.
- **[The $20 default may sit below the account's current monthly spend, so it alerts at once]** → Before deploying, check last month's bill (Billing → Bills) and set `budgetMonthlyUsd` above the normal baseline.
- **[Budgets/Cost Explorer resources through an `eu-north-1` provider]** → The AWS provider sends these global APIs to their `us-east-1` endpoint whatever the provider's region. Verify in `pulumi preview`/`up`. If it fails, give `alerts.ts` an explicit `us-east-1` provider for the budget and Cost Explorer resources only.
- **[A DLQ that already holds messages alarms right after the first deploy]** → Intended. Check the DLQs before deploying so the first email is not a surprise.
- **[One recipient]** → Accepted for a two-user system. The SNS topic can take more subscriptions later without a spec change.

## Migration Plan

1. Set the config: `pulumi config set --secret alertEmail "<address>"`. Optionally `pulumi config set budgetMonthlyUsd <amount>`, after checking last month's bill.
2. Check Cost Anomaly Detection for an existing services monitor. If there is one, run `pulumi config set anomalyMonitorArn <arn>`.
3. Run `pnpm exec nx run infra:preview`. Expect creates for the topic, the subscription, the budget, the monitor (unless reused), the anomaly subscription and 4 alarms, plus one in-place update of the `ingestion` queue, with no replacements. Then run `pnpm exec nx run infra:up`.
4. Click the confirmation link in the "AWS Notification - Subscription Confirmation" email.
5. Test end to end:

   ```bash
   aws cloudwatch set-alarm-state --alarm-name draupnir-prod-ingestion-dlq-messages \
     --state-value ALARM --state-reason test
   ```

   Confirm the email arrives. The next evaluation returns the alarm to OK by itself.

**Rollback:** remove the `createAlerts` call and run `pulumi up`. Nothing stateful is lost. The queue retention can stay as it is.
