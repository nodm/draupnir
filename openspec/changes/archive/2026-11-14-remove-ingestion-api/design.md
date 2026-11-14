## Context

See proposal.md (Why) for the motivation. The current state:

- **`infra/lib/ingestionApi.ts`** creates the `draupnir-ingestion` RestApi, which contains:
  - a `COGNITO_USER_POOLS` authorizer with no scopes, so it accepts ID tokens issued to any client of the pool;
  - `whoami`, written by hand;
  - `accounts` and `presigned-upload`, built through `createLambdaRoute`;
  - a deployment, a stage and a `*/*` throttle of 5/10.

  `presigned-upload`'s role may `s3:PutObject` on `uploads-bucket/*`.
- **`infra/lib/cognito.ts`** creates the `draupnir-app` public client: Google only, code flow, callback `config.get('callbackUrl') ?? 'http://localhost:5173/callback'`. It has Managed Login branding and is returned in `AuthPool.userPoolClient`. `infra/index.ts` exports `userPoolClientId`, `ingestionApiId` and `ingestionInvokeUrl`.
- **Other user pool clients:**
  - `draupnir-telegram` (`bot.ts`) has a secret. The bot callback verifies the ID token's `aud` against it with `aws-jwt-verify`.
  - `mcp-dcr-*` clients are registered at runtime by the MCP OAuth shim.
- **Who writes `uploads/`:** besides `presigned-upload`, only the `bot-worker` role (`s3:PutObject` on `uploads/*`, `IfNoneMatch: '*'`). The bot checks owner membership before it writes.
- **Ingestion worker trust model** (`processStatementFile.ts`): it acts as the `sub` in the object key. The comments justify that with "only the presigned-URL endpoint issues keys". The worker also re-checks ownership and object size at processing time.
- **`ingestion/src` build entries:** `whoami.ts`, `accounts.ts` and `presignedUpload.ts` are extra esbuild entry points in `ingestion/project.json`. `lib/auth.ts` (`requireSub`) is used only by them. The bot creates accounts through `shared`'s `createAccount`, not through `ingestion/src/accounts.ts`.
- **No callers in the repo:** nothing calls the API; `ingestion/README.md` documents only hand-run `curl`. `aws-amplify` is a root dependency that no code imports.

## Goals / Non-Goals

**Goals:**

- Remove every resource, code path, dependency and doc that exists only for the ingestion API and the `draupnir-app` client.
- After the change, no API accepts a user pool token issued to a client other than its own. A guardrail test keeps it that way.
- The bot, the MCP server and the ingestion pipeline behave exactly as before.

**Non-Goals:**

- Hardening the unauthenticated MCP OAuth endpoints, such as the registration cap and the discovery throttles. That is a separate change.
- A bucket policy that denies `uploads/` writes from everyone except the bot role.
- Keeping any part of the API for a future frontend. Decision 1 records how one would come back.

## Decisions

### 1. Remove the API instead of hardening it

The alternative was to keep the API and fix it:

- check `aud` (or `client_id`) against `draupnir-app` in every handler;
- cut the presigned POST to about 60 s;
- add a per-user quota on uploads.

That is three fixes and their tests, for routes nothing calls. Removal closes both issues with no new code to maintain. It also matches ADR-0009, which records the decision that made the API unnecessary.

If a frontend is ever built, it gets a new API whose authorizer, or whose handler, accepts only its own client's tokens. The new user-authentication requirement already says so ("Any other route that receives a user pool token SHALL verify that the token was issued to that route's own app client").

### 2. One `pulumi up` deletes the resources in dependency order

There are no import or retain tricks: removing the code is the whole migration. Pulumi deletes dependents first: the method settings, stage, deployment, integrations, methods, permissions and authorizer, then the RestApi, then the Lambdas, their roles and policies, and their log groups. The branding goes before the `draupnir-app` client.

**Log groups:** `/aws/lambda/draupnir/prod/{whoami,accounts,presigned-upload}` are deleted together with their history. No investigation needs those logs, and keeping them with `retainOnDelete` would leave orphaned resources outside the stack.

**Other functions:** the `ingest` and `rebuild-account` bundles change, because `dist/ingestion` loses three entry files and the regenerated lockfile changes. Pulumi updates them in place.

### 3. Guardrail: exactly one REST API with a user pool authorizer

`guardrails.spec.ts` gains an assertion: the recorded `aws:apigateway/authorizer:Authorizer` resources of type `COGNITO_USER_POOLS` are exactly one, and its `restApi` is the `mcp` API. The existing assertions change too:

- the REST APIs are exactly `['bot', 'mcp']`;
- the function list shrinks from 13 to 10;
- the ingestion stage throttle test is removed.

**Why one authorizer rather than an `aud` check:** an authorizer with no scopes accepts ID tokens from every client of the pool. That is the root of the finding, so the cheapest regression test is "no second authorizer". The bot callback's audience check is already covered by `bot` tests (`idToken.spec.ts`).

### 4. Trust model comments name the bot

The worker's comments change from "only the presigned-URL endpoint issues keys" to the actual guarantee. Only the `bot-worker` role may write `uploads/`, and the bot checks owner membership before it writes. The worker's own re-checks stay unchanged as defence in depth: ownership at processing time, size from `GetObject`, and a not-owner rejection that is not retried. The comment about a key being "reusable until the presigned URL expires" now says that any writer could replace an object before the event is processed.

The comment in `mcp/src/lib/oauth.ts` ("The other APIs must refuse tokens issued to `mcp-dcr-` clients themselves") becomes a statement of the fact, pointing at the guardrail: no other API accepts user pool tokens, and the bot callback checks its own audience.

### 5. Comments that pointed into `ingestionApi.ts` move to `mcpApi.ts`

`mcpApi.ts` refers to "ingestionApi.ts's restApi comment" (the REGIONAL endpoint rationale) and "ingestionApi.ts's deployment comment" (hash route config, not ids). Those two rationales are copied inline. `lambdaRoute.ts`'s header comment drops its `whoami` history.

The `createLambdaRoute` helper stays, because `mcp` uses it. `dataApiPolicyStatements` stays, because the bot, the pipeline and `mcp` use it.

### 6. Dependencies

- Remove `@aws-sdk/s3-presigned-post` from `ingestion/package.json`, since only `lib/presignedUpload.ts` imports it.
- Remove `aws-amplify` from the root `package.json`, since nothing imports it.
- `pnpm install` (pnpm 12) updates `pnpm-lock.yaml`. `pnpm dedupe --check` must stay clean, so the lockfile diff contains only the two removals and their now-unused transitive packages.

### 7. Docs and ADRs are annotated, not rewritten

- **ADR-0002 and ADR-0004:** each gets a dated note under Status: "partly superseded by ADR-0009: the browser client was never built; the app REST API and `draupnir-app` client were removed in `remove-ingestion-api`". The rest stays as the record of what was decided then.
- **`docs/architecture.md`:**
  - the API subgraph and the `draupnir-app` node leave the mermaid diagram, with their edges (including `MigrateInvocation` → `AccountsFn`/`UploadFn`);
  - the Notes lose the `whoami` bullet and the ingestion throttle figures.
- **`infra/README.md`:** drop the ingestion parts of "API guardrails" and the `callbackUrl`/`logoutUrl` line.
- **`ingestion/README.md`:** replace the `POST /uploads` walkthrough with one line: statements arrive through the Telegram bot.

### 8. Main spec Purposes updated with the change

Three main specs describe the removed surface in their Purpose:

- `user-authentication` ("every request reaching a handler on `ingestion`'s authenticated routes…");
- `statement-csv-upload` ("by issuing a presigned S3 POST…");
- `account-management` ("a minimal create-only endpoint").

Purpose is not part of a delta, so these are edited directly in `openspec/specs/` as part of this change. `account-management` has no requirement changes: its requirement ("an authenticated caller can create an owned account") is still met by the bot's `/newaccount`, through `shared`'s `createAccount`.

## Risks / Trade-offs

- **[An unknown script calls the ingestion URL]** → Nothing in the repo does. Before deploying, check the API's 30-day request count (Migration Plan step 1). Any requests there other than the maintainer's own tests mean stopping and asking.
- **[A refresh token issued to `draupnir-app` stops working]** → Intended. No client uses it.
- **[Deleting the log groups loses those functions' history]** → Accepted (Decision 2).
- **[Rollback recreates resources under new identifiers]** → A revert and `pulumi up` creates a new RestApi id (a new URL) and a new client id. Acceptable, since nothing depends on either.
- **[Disclosure before the fix is live]** → The branch stays local until the deploy (maintainer's decision). The proposal states the issue without a step-by-step recipe.

## Migration Plan

1. Check the ingestion API's request count for the last 30 days:

   ```bash
   aws cloudwatch get-metric-statistics --namespace AWS/ApiGateway --metric-name Count \
     --dimensions Name=ApiName,Value=draupnir-ingestion Name=Stage,Value=prod \
     --start-time "$(date -u -d '30 days ago' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
     --period 86400 --statistics Sum
   ```

   Expect no requests, or only known hand tests.
2. Run `pnpm exec nx run infra:preview`. Expect deletes for the RestApi and its children, the 3 Lambdas with their roles, policies, permissions and log groups, the `draupnir-app` client and its branding. Expect in-place updates for functions whose bundles changed, and **no replacements or creates**.
3. Run `pnpm exec nx run infra:up`.
4. Smoke test: send `/accounts` to the bot, and call an MCP tool from a connected client. Both should work as before. The old ingestion invoke URL should no longer answer.
5. Push the branch and open the PR.

**Rollback:** `git revert` the change and run `pulumi up`. That recreates the API and the client under new identifiers.
