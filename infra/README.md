# infra

Pulumi TypeScript. See [ADR-0005](../docs/adr/0005-aws-region-selection.md) (region)
and [ADR-0006](../docs/adr/0006-pulumi-state-backend.md) (state backend) for the
reasoning behind the setup below.

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

`callbackUrl`/`logoutUrl` are optional (`pulumi config set callbackUrl "..."`)
and default to `localhost` values meant for local client development.

## Deploying

Use the Nx targets, not bare `pulumi preview`/`pulumi up` — the Pulumi program
archives `dist/infra/preSignUpTrigger` and `dist/ingestion` as Lambda code, and
those `dist/` directories don't exist until the Nx targets that build them run
first:

```bash
pnpm exec nx run infra:preview
pnpm exec nx run infra:up
```

Both targets depend on `infra:build-pre-sign-up-trigger` and `ingestion:build`,
so Nx builds both Lambda archives before invoking Pulumi.
