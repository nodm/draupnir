## Why

The cost guardrails cap how fast the stack can spend money: API throttles, caps on queue concurrency, Aurora's 1 ACU ceiling and log retention. Nothing tells the maintainer when spend actually rises. Traffic held at a throttle limit for weeks, or a queue backlog that keeps Aurora awake, shows up only on the monthly invoice. Failures are just as quiet: a statement that ends in a dead-letter queue, or a backlog in the ingestion queue, is visible only to someone who checks the console. The ingestion queue also keeps the SQS default retention of 4 days. If a backlog lasts longer than that, waiting uploads are deleted without any trace.

## What Changes

- **Monthly budget alerts**: an AWS Budget covers the whole account's monthly cost. The limit comes from the Pulumi config key `draupnir-infra:budgetMonthlyUsd` (default 20). An email goes out when actual spend reaches 100% and 250% of the limit (by default $20 and $50), and when forecast spend reaches 100%. A value that is not a positive number fails `pulumi preview`.
- **Cost anomaly alerts**: a Cost Anomaly Detection monitor for AWS services, with a daily email summary of anomalies above a small dollar impact. If the account already has a services monitor, it is reused instead of a second one being created. AWS allows only one such monitor per account.
- **Operational alarms**: CloudWatch alarms notify an SNS topic that sends email.
  - A message arrives in any of the three dead-letter queues: `ingestion-dlq`, `bot-updates-dlq` or `bot-outcomes-dlq`.
  - The oldest message in the `ingestion` queue is older than 1 hour. That age is a backlog, not a normal retry.
- **Alert recipient**: one address from a new required secret config key, `draupnir-infra:alertEmail`. It never appears in the repository. The maintainer confirms the SNS email subscription once, after the first deploy.
- **Ingestion queue retention**: the `ingestion` queue keeps messages for 14 days (the SQS maximum) instead of the 4-day default.
- **Docs**: `infra/README.md` gets an "Alerts" section: the config keys and their defaults, the one-time confirmation of the email subscription, and what each alarm means.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `cost-guardrails`: adds requirements that spend and cost anomalies are reported by email against a configurable monthly budget, that dead-letter arrivals and an ingestion backlog raise alarms, that invalid budget or alert config fails before deploy, and that the alerts are documented.
- `statement-ingestion-pipeline`: adds a requirement that an uploaded file's message waits in the ingestion queue for up to 14 days before SQS deletes it.

## Impact

- **Code**: a new `infra/lib/alerts.ts`, which holds the budget config parser, the SNS topic, the budget, the anomaly monitor and subscription, and the alarms. It is called from `infra/index.ts` with the queues from `ingestionPipeline.ts` and `botQueues.ts`. `ingestionPipeline.ts` gets `messageRetentionSeconds` on the `ingestion` queue. The guardrail tests in `infra/src/guardrails.spec.ts` are extended, and the test config gains `alertEmail`.
- **AWS resources**:
  - 1 SNS topic and 1 email subscription.
  - 1 budget.
  - 1 anomaly monitor, or none if one is reused, and 1 anomaly subscription.
  - 4 CloudWatch alarms.
  - An in-place update to the `ingestion` queue.
- **Config**: `alertEmail` (required, secret) and `budgetMonthlyUsd` (optional) are new. Until `alertEmail` is set on the stack, `pulumi preview` fails.
- **Cost**: about $0.40/month for 4 alarms. The budget fits in the free tier of two budgets. Cost Anomaly Detection is free, and SNS email stays in the free tier.
- **Operations**: one email confirmation after the first deploy. Before deploying, the maintainer checks for an existing anomaly monitor.
