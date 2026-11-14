## Why

No Lambda function in this stack has a log group managed by the deployment. Lambda creates `/aws/lambda/<function-name>` on the first invocation with retention "Never expire", so every log line ever written is stored and billed indefinitely. Invocation volume is capped (API throttles, queue concurrency caps), but storage is not: a burst of invocations becomes permanent storage. The cost guardrails cap how much the system can do, but not how long it keeps what it logged.

## What Changes

- Every Lambda function writes to a log group that the deployment creates and owns, with a retention period. This covers all 13 functions: `pre-sign-up-trigger`, `migrate-database`, `ingest`, `rebuild-account`, `whoami`, the `createLambdaRoute` functions (`accounts`, `presigned-upload`, `mcp`), `mcp-oauth`, `bot-webhook`, `bot-callback`, `bot-worker` and `bot-retention`. `whoami` was not in the original list, but it is a Lambda like the rest and is covered too.
- The new log groups have fixed names, `/aws/lambda/draupnir/<stack>/<function>`. Each function is attached to its group through its logging configuration. The auto-created `/aws/lambda/<physical-name>` groups are not imported. Once the deploy is verified, a documented one-off manual step deletes them. The reasons for this choice over importing are in design.md.
- The retention is read from the Pulumi config key `draupnir-infra:logRetentionDays`, default 30. A value that CloudWatch Logs does not accept fails `pulumi preview` before anything changes.
- All Lambda functions are built through one shared constructor, which creates the log group with the function. A guardrail test fails if any function in the program lacks a managed log group with the configured retention, so a new function cannot skip it.
- Log format stays plain text and nothing is filtered by log level. design.md looks at switching to JSON logs with an application log level of WARN and puts it off for a later change.
- Documentation: `infra/README.md` gets a log-retention section, and the optional config key is listed. The troubleshooting steps in `docs/telegram-bot.md` point at the new group names.
- **BREAKING (operational only)**: logs move to the new group names, so commands and bookmarks that use `/aws/lambda/<physical-name>` stop showing new events. Older events stay in the old groups until the cleanup step deletes them.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `cost-guardrails`: adds requirements that every Lambda function's logs are kept for a bounded, configurable period (default 30 days, invalid values rejected at preview), that no function of the stack is left writing to a group that never expires, and that the retention and log locations are documented.

## Impact

- **Code**: `infra/lib/` gets a shared Lambda constructor and a retention-config parser. The constructor is used in `cognito.ts`, `databaseMigrations.ts`, `ingestionPipeline.ts`, `ingestionApi.ts`, `lambdaRoute.ts`, `mcpApi.ts` and `bot.ts`. The guardrail tests in `infra/src/guardrails.spec.ts` are extended.
- **AWS resources**: 13 new `aws.cloudwatch.LogGroup` resources. Each function gets an in-place update to its logging configuration; no function is replaced. IAM does not change, because `AWSLambdaBasicExecutionRole` already grants the log actions on all resources (see design.md).
- **Operations**: one manual cleanup after the first deploy deletes the 13 old groups. Log tailing commands change to the new names.
- **Cost**: log storage stops growing without limit. It is bounded by about 30 days of ingestion. Ingestion volume does not change.
