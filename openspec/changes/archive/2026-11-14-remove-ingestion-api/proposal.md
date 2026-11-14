## Why

The `draupnir-ingestion` REST API (`GET /whoami`, `POST /accounts`, `POST /uploads`) and the `draupnir-app` Cognito client were built for a browser client planned in ADR-0002. That client was never built. ADR-0009 then made the Telegram bot the only interface, and the bot creates accounts through `shared` and writes uploads to S3 itself. Nothing calls the API any more, but it still costs attack surface:

- Its Cognito authorizer accepts an ID token issued to *any* client of the user pool, including the clients that MCP clients register. An MCP client is meant to be read-only, but through this API it can create accounts and upload statements.
- `POST /uploads` hands out a signed S3 upload form that can be reused for 15 minutes. Uses of the form go straight to S3, so the API's throttle does not apply, and each one starts an ingestion run.

Removing the unused API is simpler and safer than hardening it.

## What Changes

- **BREAKING**: remove the `draupnir-ingestion` REST API: its stage and throttle, its Cognito authorizer, the `whoami`, `accounts` and `presigned-upload` Lambdas with their roles and log groups, and the stack outputs `ingestionApiId` and `ingestionInvokeUrl`.
- **BREAKING**: remove the `draupnir-app` Cognito app client, its Managed Login branding, the optional `callbackUrl`/`logoutUrl` config, and the `userPoolClientId` output.
- Remove the matching code: the three handlers and their libraries (`whoami`, `accounts`, `presignedUpload`, `auth`), their tests and build entry points, and the `@aws-sdk/s3-presigned-post` dependency. Also remove the unused root dependency `aws-amplify`.
- After this change only the MCP API accepts bearer tokens from the user pool. A guardrail test pins that, so a new API cannot quietly start accepting tokens issued to other clients.
- Update the comments that relied on "the presigned-URL endpoint" as the only writer of upload keys. After this change the Telegram bot is the only writer.
- Docs: update `docs/architecture.md`, `infra/README.md` and `ingestion/README.md`. Add notes to ADR-0002 and ADR-0004 that their browser-client and app-API parts are superseded by ADR-0009.

Out of scope: hardening the public MCP OAuth endpoints (a separate change), and a bucket policy limiting who may write `uploads/`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `user-authentication`: removes the whoami endpoint and the ingestion API throttle requirements, and adds a requirement that only the MCP API accepts the user pool's bearer tokens.
- `statement-csv-upload`: removes the presigned-upload and S3-enforced-size requirements. The trigger and the worker's size re-check now describe uploads written by the Telegram bot.
- `mcp-server-api`: the authorizer requirement no longer says "the same pool `ingestion` uses".
- `mcp-oauth-discovery`: the stripped `id_token` is no longer described as a token "that would also authenticate against the other APIs".

## Impact

- **AWS resources (deleted)**:
  - the `draupnir-ingestion` RestApi, with its authorizer, resources, methods, integrations, deployment, stage and method settings;
  - 3 Lambda functions, with their IAM roles and policies, invoke permissions and log groups (the log history of those 3 functions is deleted);
  - the `draupnir-app` UserPoolClient and its ManagedLoginBranding.

  No data store changes. Aurora, the uploads bucket, the queues and the pipeline stay as they are.
- **Code**: `infra/lib/ingestionApi.ts` is deleted. Changes in `infra/index.ts`, `infra/lib/cognito.ts` (the `AuthPool` type loses `userPoolClient`) and `infra/lib/mcpApi.ts` (absorbs the rationale comments it pointed to in `ingestionApi.ts`), plus `infra/src/guardrails.spec.ts` and `infra/src/bot.spec.ts`. In `ingestion/`: the handlers, libraries, tests and build entries. `mcp/src/lib/oauth.ts` gets a comment update. Root `package.json`, `ingestion/package.json` and `pnpm-lock.yaml` change.
- **Clients**: none known. A script that still calls the ingestion URL gets an error after the deploy.
- **Security and cost**: closes the two issues above. The 3 Lambdas, the API stage and the extra app client go away.
