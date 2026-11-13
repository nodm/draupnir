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
[the change's design](../openspec/changes/add-api-throttle-defaults/design.md).

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
