## 1. Infra

- [x] 1.1 Delete `infra/lib/ingestionApi.ts`. Remove its call and the `ingestionApiId`/`ingestionInvokeUrl` exports from `infra/index.ts`. Copy the two rationale comments that `infra/lib/mcpApi.ts` points to (REGIONAL endpoint, hashing the route config for redeploys) inline into `mcpApi.ts`, and drop the `whoami` history from `infra/lib/lambdaRoute.ts`'s header comment (design Decisions 2 and 5). Verify with `pnpm exec nx run infra:build`.
- [x] 1.2 Remove the `draupnir-app` `UserPoolClient`, its `ManagedLoginBranding` and the `callbackUrl`/`logoutUrl` config reads from `infra/lib/cognito.ts`. Drop `userPoolClient` from `AuthPool`, and drop the `userPoolClientId` export from `infra/index.ts`. Update the `AuthPool` stub in `infra/src/bot.spec.ts`. Verify with `pnpm exec nx run infra:build` and `grep -rn "userPoolClient\b\|draupnir-app'\|callbackUrl')" infra/lib infra/index.ts` returning nothing.

## 2. Ingestion code

- [x] 2.1 Delete `ingestion/src/whoami.ts`, `ingestion/src/accounts.ts`, `ingestion/src/accounts.spec.ts`, `ingestion/src/presignedUpload.ts`, and `ingestion/src/lib/{whoami,presignedUpload,auth}.ts` with their specs. Remove the three entries from `additionalEntryPoints` in `ingestion/project.json`. Verify that `pnpm exec nx run-many -t build test -p ingestion` passes and that `dist/ingestion` contains only `handler.js` and `rebuildAccount.js` as entry files.
- [x] 2.2 Rewrite the trust-model comments in `ingestion/src/lib/processStatementFile.ts` (the four "presigned" references, design Decision 4) and in `shared/src/lib/statementLimits.ts`, without changing any logic. Verify that `grep -rn -i presigned ingestion/src shared/src` returns nothing and that `pnpm exec nx test ingestion shared` passes.
- [x] 2.3 Replace the `withoutIdToken` comment in `mcp/src/lib/oauth.ts`: no other API accepts user pool tokens (pinned by the infra guardrail), and the bot callback checks its own audience. Verify that `pnpm exec nx test mcp` passes.

## 3. Dependencies

- [x] 3.1 Remove `@aws-sdk/s3-presigned-post` from `ingestion/package.json` and `aws-amplify` from the root `package.json`, then run `pnpm install`. Verify that `pnpm install --frozen-lockfile` and `pnpm dedupe --check` are clean, and that `grep -n "aws-amplify\|s3-presigned-post" pnpm-lock.yaml` returns nothing.

## 4. Guardrail tests

- [x] 4.1 In `infra/src/guardrails.spec.ts`, remove `createIngestionApi` from the program mirror and remove the ingestion throttle test. Update the REST API list to `['bot', 'mcp']` and the function list to the remaining 10. Add a test that exactly one `COGNITO_USER_POOLS` authorizer is recorded and that it belongs to the `mcp` RestApi (design Decision 3), and update the header comment. Verify with `pnpm exec nx test infra`.
- [x] 4.2 Temporarily add a second `COGNITO_USER_POOLS` authorizer to the program (for example, on the bot RestApi), confirm that the test from 4.1 fails, then revert. Note the failing assertion for the PR description.

## 5. Docs, ADRs and spec purposes

- [x] 5.1 In `docs/architecture.md`, remove the API subgraph, the `draupnir-app` node and their edges (including `MigrateInvocation` → `AccountsFn`/`UploadFn`) from the mermaid diagram. In the Notes, drop the `whoami` bullet and the `draupnir-ingestion` throttle figures, and make the concurrency note's per-stage sum add up. Verify that the mermaid block references no removed node id (`grep -n "WhoamiFn\|AccountsFn\|UploadFn\|RestApi\b\|Authorizer\b\|UserPoolClient" docs/architecture.md` returns nothing) and that Prettier passes.
- [x] 5.2 In `infra/README.md`, drop the ingestion API parts of "API guardrails" and the `callbackUrl`/`logoutUrl` line. In `ingestion/README.md`, replace the `POST /uploads` walkthrough with a short note that statements arrive through the Telegram bot. Verify that `grep -rn "ingestionInvokeUrl\|ingestionApiId\|POST /uploads" infra ingestion docs` returns nothing and that Prettier passes.
- [x] 5.3 Add a dated "partly superseded by ADR-0009" note under Status in `docs/adr/0002-auth-request-flow.md` and `docs/adr/0004-ingestion-flow-shape.md` (design Decision 7). Verify by reading both Status sections.
- [x] 5.4 Update the Purpose sections of `openspec/specs/user-authentication/spec.md`, `openspec/specs/statement-csv-upload/spec.md` and `openspec/specs/account-management/spec.md` so they no longer describe the ingestion API (design Decision 8). Verify with `pnpm exec openspec validate --specs --strict`.
- [x] 5.5 Run `pnpm exec openspec validate remove-ingestion-api --strict` and confirm that it passes.

## 6. Full checks

- [x] 6.1 Run `pnpm exec nx run-many -t lint build test --all --parallel=1` and confirm that every project passes.

## 7. Deploy (manual or with the maintainer, before the branch is pushed)

- [x] 7.1 Check the `draupnir-ingestion` 30-day request count (design Migration Plan, step 1). Verify that it shows no requests, or only known hand tests; otherwise stop and ask.
- [x] 7.2 Run `pnpm exec nx run infra:preview`. Confirm only deletes of the ingestion API's resources, the 3 functions with their roles, permissions and log groups, and the `draupnir-app` client and branding, plus in-place updates of functions whose bundles changed, with no replacements or creates. Then run `pnpm exec nx run infra:up`.
- [x] 7.3 Smoke test: `/accounts` in the bot works, an MCP tool call works, and the old ingestion invoke URL no longer answers. Verify by recording the three results for the PR description.
