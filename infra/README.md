# infra

Pulumi TypeScript. See [ADR-0005](../docs/adr/0005-aws-region-selection.md) (region)
and [ADR-0006](../docs/adr/0006-pulumi-state-backend.md) (state backend) for the
reasoning behind the setup below, and [../docs/architecture.md](../docs/architecture.md)
for a diagram of the resources provisioned.

## State backend

State lives in a self-managed S3 bucket + KMS-encrypted secrets, shared across
Dmytro's personal projects (not managed by this Pulumi stack itself — bootstrapped
once, out-of-band):

- Bucket: `nodm-pulumi-state` (eu-north-1)
- KMS key alias: `alias/nodm-pulumi-state`
- This project's state prefix: `s3://nodm-pulumi-state/draupnir`

### First-time login on a new machine

```bash
pulumi login s3://nodm-pulumi-state/draupnir
# stack already exists after the first `pulumi stack init` — no need to re-init
```

### Bootstrap from scratch (bucket/key already exist — reference only)

```bash
aws s3api create-bucket \
  --bucket nodm-pulumi-state --region eu-north-1 \
  --create-bucket-configuration LocationConstraint=eu-north-1

aws s3api put-bucket-versioning \
  --bucket nodm-pulumi-state --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket nodm-pulumi-state \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block \
  --bucket nodm-pulumi-state \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws kms create-key --region eu-north-1 \
  --description "Pulumi state secrets - personal projects" \
  --query 'KeyMetadata.KeyId' --output text
# copy the returned key id into the next command
aws kms create-alias --region eu-north-1 \
  --alias-name alias/nodm-pulumi-state --target-key-id <key-id-from-above>

pulumi login s3://nodm-pulumi-state/draupnir
pulumi stack init prod --secrets-provider="awskms://alias/nodm-pulumi-state?region=eu-north-1"
```

If `nodm-pulumi-state` is taken globally, fall back to
`nodm-pulumi-state-<account-id>` and update this file + ADR-0006.

## Required stack config

`createAuthPool` (`infra/lib/cognito.ts`) reads these config values; `pulumi
preview`/`pulumi up` fail without them set on the stack:

```bash
pulumi config set --secret allowlistedEmails "me@example.com,wife@example.com"
pulumi config set --secret google:clientId "<google-oauth-client-id>"
pulumi config set --secret google:clientSecret "<google-oauth-client-secret>"
pulumi config set authDomainPrefix "<cognito-managed-login-domain-prefix>"
```

`createAlerts` (`infra/lib/alerts.ts`) needs the address that gets spend and
failure alerts. It is a secret, so it never appears in this public repository;
see [Alerts](#alerts):

```bash
pulumi config set --secret alertEmail "<address>"
```

`google:clientId`/`google:clientSecret` come from a Google Cloud OAuth 2.0
client (Web application type, with the Cognito domain's `/oauth2/idpresponse`
callback URL registered) — not created by this Pulumi program. `authDomainPrefix`
must be globally unique across all Cognito user pools (e.g. `draupnir-auth`).

`createBot` (`infra/lib/bot.ts`) also needs the Telegram bot's username (the
`@name` BotFather gave it, without the `@`); links to the bot are built from it:

```bash
pulumi config set botUsername "<bot-username>"
```

The bot token itself is **not** Pulumi config: create the bot with BotFather,
store the token in the `bot-token` secret, then point Telegram at the webhook:

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(pulumi stack output botTokenSecretArn)" --secret-string '<token>'
pnpm exec nx run bot:set-webhook      # `bot:delete-webhook` undoes it
```

`callbackUrl`/`logoutUrl` are optional (`pulumi config set callbackUrl "..."`)
and default to `localhost` values meant for local client development.

`logRetentionDays` is optional and defaults to 30; see [Log retention](#log-retention).

`uploadRetentionDays` is optional and defaults to 30; see [Upload retention](#upload-retention).

`budgetMonthlyUsd` (default 20) and `anomalyMonitorArn` are optional; see [Alerts](#alerts).

## Deploying

Use the Nx targets, not bare `pulumi preview`/`pulumi up` — the Pulumi program
archives `dist/infra/preSignUpTrigger`, `dist/ingestion`, `dist/bot`, and `dist/mcp` as
Lambda code, and those `dist/` directories don't exist until the Nx targets
that build them run first:

```bash
pnpm exec nx run infra:preview
pnpm exec nx run infra:up
```

Both targets depend on `infra:build-pre-sign-up-trigger`, `ingestion:build`,
`bot:build`, and `mcp:install-deps`, so Nx builds all the Lambda archives before invoking
Pulumi.

## API guardrails

Cost and capacity guardrails on the REST API stages, so a flood of requests has a
bounded cost and leaves Lambda capacity for the rest of the system (the account
allows 10 concurrent executions; see `docs/architecture.md`, Concurrency). Each
stage has a default throttle on every method (`MethodSettings` with
`methodPath: '*/*'`); a method-level setting overrides it for that method:

| Stage                | Default (`*/*`), rps / burst | Overrides                                  |
| -------------------- | ---------------------------- | ------------------------------------------ |
| `draupnir-mcp`       | 10 / 20                      | `token/POST` 5 / 10, `register/POST` 1 / 5 |
| `draupnir-ingestion` | 5 / 10                       | none                                       |
| `draupnir-bot`       | 10 / 20                      | none                                       |

The limit applies to **each method separately**, not to the stage as a whole, so
a stage's total ceiling is the sum over its methods: about 66 rps (burst 135)
for MCP (6 methods on the default plus the two overrides) and 15 rps (burst 30)
for ingestion (3 methods). A request over the limit gets `429 Too Many Requests`
from API Gateway, before any authorizer or Lambda function runs. The limits are
shared by all callers of a method, so a flood also throttles the real users
until it stops. The numbers are explained in
[the change's design](../openspec/changes/archive/2026-11-13-add-api-throttle-defaults/design.md).

The MCP API is served only on `https://mcp.draupnir.nodm.name`: its default
`execute-api` endpoint is disabled (it answers `403`), and `mcpUrl` is the only
MCP stack output. The ingestion and bot APIs keep their `execute-api` URLs.

After a deploy, check the settings each stage actually has:

```bash
aws apigateway get-stage --rest-api-id "$(pulumi stack output mcpApiId)" \
  --stage-name prod --query methodSettings
aws apigateway get-stage --rest-api-id "$(pulumi stack output ingestionApiId)" \
  --stage-name prod --query methodSettings
```

Not used: AWS WAF. A web ACL with a rate-based rule could limit each IP
separately, so one caller couldn't use up a method's limit for everyone, but it
has its own monthly charge plus per-rule and per-request charges. It is the next
step if a flood ever locks the users out.

## Log retention

Every Lambda function writes to its own log group, created by this stack with a
retention period, so logs are never kept forever (Lambda's auto-created
`/aws/lambda/<function-name>` groups never expire). The groups are named
`/aws/lambda/draupnir/<stack>/<function>`, using the function's Pulumi name
rather than its random-suffixed physical name:

```bash
aws logs tail /aws/lambda/draupnir/prod/bot-worker --since 1h
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/draupnir/prod/ \
  --query 'logGroups[].[logGroupName,retentionInDays]' --output table
```

The retention comes from `logRetentionDays` (default 30 days):

```bash
pulumi config set logRetentionDays 14
```

It must be a period CloudWatch Logs accepts: 1, 3, 5, 7, 14, 30, 60, 90, 120,
150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288 or 3653. Any
other value (including 0, "never expire") fails `infra:preview`. Changing it
updates the groups in place. New functions get a group automatically through
`createLambdaFunction` (`lib/lambdaFunction.ts`); a guardrail test fails for
any function without one.

Log format is plain text with no level filtering. JSON format with a WARN level
was considered and deferred; see
[the change's design](../openspec/changes/archive/2026-11-14-set-lambda-log-retention/design.md),
decision 5.

### One-off cleanup of the old log groups

After the first deploy with managed log groups, the old auto-created groups stop
receiving events but keep everything they hold, forever. Once new events show up
in the `/aws/lambda/draupnir/prod/` groups, delete the old groups of this
stack's functions. Take the names from the stack state, never from a prefix,
because the account may hold other functions' groups. Run from `infra/`, review
the printed list, then replace `echo` with the delete command:

```bash
for fn in $(pulumi stack export | jq -r '.deployment.resources[]
    | select(.type == "aws:lambda/function:Function") | .outputs.name'); do
  group="/aws/lambda/$fn"
  aws logs describe-log-groups --log-group-name-prefix "$group" \
    --query "logGroups[?logGroupName=='$group'].logGroupName" --output text | grep -q . \
    && echo aws logs delete-log-group --log-group-name "$group"
done
```

To keep the last month of history instead, run
`aws logs put-retention-policy --log-group-name "$group" --retention-in-days 30`
on each, and delete the emptied groups later. The loop prints nothing once the
cleanup is done.

## Upload retention

The uploads bucket has two lifecycle rules:

- `expire-uploads`: objects under `uploads/` expire after `uploadRetentionDays`
  (default 30), and noncurrent versions 1 day after they become noncurrent, which
  matters only if versioning is ever enabled;
- `abort-incomplete-multipart-uploads`: unfinished multipart uploads anywhere
  in the bucket are aborted after 1 day.

```bash
pulumi config set uploadRetentionDays 60
aws s3api get-bucket-lifecycle-configuration --bucket "$(pulumi stack output uploadsBucketName)"
```

Nothing reads an upload once its outcome is recorded: rebuilds, duplicate
detection and redeliveries use the database. The one later reader is a redrive
from the ingestion DLQ, which keeps messages for 14 days, so the value must be a
whole number greater than 14 or `infra:preview` fails. See
[the change's design](../openspec/changes/archive/2026-11-14-expire-uploads-and-enforce-size-at-s3/design.md).

S3 applies the rule to existing objects too: within a day or two of the first
deploy, every upload older than the retention is deleted, and that cannot be
undone. To keep a copy, back the bucket up first:

```bash
aws s3 sync "s3://$(pulumi stack output uploadsBucketName)" ./uploads-backup
```

## Alerts

The guardrails above cap how fast the stack can spend; these alerts say when it
does, and when something fails quietly. Everything goes to one address,
`alertEmail` (required, secret). See
[the change's design](../openspec/changes/add-spend-alarms/design.md).

### Budget

A monthly cost budget, `draupnir-<stack>-monthly`, covers **the whole AWS
account**, not only this stack: everything in the account is billed to the same
card. It emails `alertEmail` directly (no confirmation needed) when:

| Alert          | At the default limit ($20) |
| -------------- | -------------------------- |
| actual 100 %   | $20                        |
| actual 250 %   | $50                        |
| forecast 100 % | $20                        |

```bash
pulumi config set budgetMonthlyUsd 40   # any positive amount; 0 or text fails infra:preview
```

Set it above the account's normal monthly spend (Billing → Bills), or the first
alert arrives at once. Billing data lags by several hours, so this is a
backstop, not real-time protection.

### Cost anomalies

A Cost Anomaly Detection subscription emails a daily summary of anomalies with a
total impact of $5 or more. AWS allows one services monitor per account. If the
account already has one (Billing and Cost Management → Cost Anomaly Detection →
Cost monitors, type "AWS services"), reuse it instead of letting the stack
create a second, which AWS refuses:

```bash
pulumi config set anomalyMonitorArn "arn:aws:ce::<account-id>:anomalymonitor/<id>"
```

Without the key, the stack creates `draupnir-<stack>-services`. Reusing by ARN
leaves an existing monitor out of the stack, so `pulumi destroy` cannot delete it.

### Queue alarms

Four CloudWatch alarms publish to the SNS topic `draupnir-<stack>-alerts`
(stack output `alertsTopicArn`), which emails `alertEmail`. **After the first
deploy, click the link in the "AWS Notification - Subscription Confirmation"
email**: until then these alarms reach nobody. Then test the path end to end
(the next evaluation returns the alarm to OK by itself):

```bash
aws cloudwatch set-alarm-state --alarm-name draupnir-prod-ingestion-dlq-messages \
  --state-value ALARM --state-reason test
```

| Alarm (`draupnir-<stack>-…`)   | Means                                                                                                                                                        | Look first                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingestion-dlq-messages`       | A statement file failed every processing attempt (an unexpected error, not a validation rejection) and was not imported.                                     | `aws logs tail /aws/lambda/draupnir/prod/ingest --since 2h`; the DLQ's count: `aws sqs get-queue-attributes --queue-url "$(pulumi stack output ingestionDlqUrl)" --attribute-names ApproximateNumberOfMessages` |
| `bot-updates-dlq-messages`     | A Telegram message or button press failed 3 times and was dropped; that chat is unblocked again.                                                             | `aws logs tail /aws/lambda/draupnir/prod/bot-worker --since 2h`, then the DLQ steps in [docs/telegram-bot.md](../docs/telegram-bot.md) (Troubleshooting)                                                        |
| `bot-outcomes-dlq-messages`    | A statement result could not be reported to the chat. The retention run retries it for 48 hours, so it may still arrive.                                     | `aws logs tail /aws/lambda/draupnir/prod/bot-worker --since 2h`                                                                                                                                                 |
| `ingestion-oldest-message-age` | A statement file has waited in the ingestion queue for over an hour: processing is stuck or swamped (normal retries end in the DLQ within about 45 minutes). | `aws sqs get-queue-attributes --queue-url "$(pulumi stack output ingestionQueueUrl)" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible`, then the `ingest` log                |

The alarms send no "OK" email: SQS stops publishing metrics for a queue that has
been idle for about 6 hours, so a dead-letter queue still holding a message
would later read as OK. Treat each alarm email as "go and look"; the count
command above says whether the message is still there.

The ingestion queue keeps a waiting file's message for 14 days (the SQS
maximum, instead of the 4-day default), so a backlog shorter than that loses no
upload.
