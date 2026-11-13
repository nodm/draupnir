## 1. Throttle defaults

- [x] 1.1 In `infra/lib/mcpApi.ts`, add a `DEFAULT_THROTTLE` constant (rate 10, burst 20) with a comment that points to design.md Decision 3, name the token limit as a constant next to the register one, and add an `mcp-default-throttle` `MethodSettings` with `methodPath: '*/*'` on the MCP stage; keep `mcp-token-throttle` and `mcp-register-throttle` unchanged. Verify with `pnpm exec nx run-many -t lint build -p infra`.
- [x] 1.2 In `infra/lib/ingestionApi.ts`, add a `THROTTLE` constant (rate 5, burst 10, "sized for two users") and an `ingestion-default-throttle` `MethodSettings` with `methodPath: '*/*'` on the ingestion stage. Verify with `pnpm exec nx run-many -t lint build -p infra`.

## 2. MCP served only on the custom domain

- [x] 2.1 In `infra/lib/mcpApi.ts`, set `disableExecuteApiEndpoint: true` on the `mcp` `RestApi`, add `restApi.disableExecuteApiEndpoint` to the MCP `Deployment`'s `triggers.redeployment` list, and replace the "The execute-api URL keeps working" comment with one saying the default endpoint is off. Verify by reading the diff: the trigger includes the new value.
- [x] 2.2 Remove `invokeUrl` from the `McpApi` interface and return value, and remove `export const mcpInvokeUrl` from `infra/index.ts`. Verify with `grep -rn "mcpInvokeUrl\|mcpApi.invokeUrl" --exclude-dir=node_modules --exclude-dir=archive .` returning nothing and `pnpm exec nx run-many -t lint build -p infra` passing.

## 3. Tests

- [x] 3.1 `git mv infra/src/concurrency.spec.ts infra/src/guardrails.spec.ts` and update its header comment to cover both the concurrency caps and the API guardrails. Verify `pnpm exec nx test infra` still passes with the existing cases.
- [x] 3.2 Add an "API guardrails" `describe` block (design.md Decision 8): per-API `MethodSettings` (`mcp`: `*/*` 10/20, `token/POST` 5/10, `register/POST` 1/5; `ingestion`: `*/*` 5/10; `bot`: `*/*` 10/20); every `RestApi` has a `*/*` default; the `mcp` `RestApi` has `disableExecuteApiEndpoint: true` and the MCP `Deployment`'s redeployment trigger contains it. Verify `pnpm exec nx test infra` passes, and that it fails if the MCP `*/*` setting is temporarily removed.

## 4. Docs

- [x] 4.1 Add an "API guardrails" section to `infra/README.md`: the limits per stage, that the limit is per method (design.md Decision 2's table of total ceilings), that the token and register limits override the MCP default, that over-limit requests get `429`, that the MCP API answers only on `mcp.draupnir.nodm.name` (`execute-api` → `403`), the post-deploy checks (`aws apigateway get-stage --rest-api-id "$(pulumi stack output mcpApiId)" --stage-name prod --query methodSettings`, and the same for `ingestionApiId`), and AWS WAF rate-based rules as a later option with their own monthly cost. Verify by reading the rendered section.
- [x] 4.2 Update `docs/architecture.md`: the Concurrency note no longer says nothing limits the public routes (it names the per-stage throttles), and the MCP API's description says it is served only on its custom domain. Verify with `grep -n "Nothing limits\|execute-api" docs/architecture.md`.
- [x] 4.3 Update ADR-0012's consequence "The `execute-api` URL stays enabled" to say it was turned off by this change (dated 2026-11-13, linking `openspec/changes/add-api-throttle-defaults`), keeping the note that the other APIs move to the domain separately. Verify by reading the ADR.

## 5. Checks and deploy

- [x] 5.1 Run `pnpm exec nx run-many -t lint build test -p infra` and `pnpm exec openspec validate add-api-throttle-defaults --strict`; both pass.
- [x] 5.2 Run `pnpm exec nx run infra:preview` and confirm it shows only: two new `MethodSettings`, the MCP `RestApi` updated in place, the MCP `Deployment` replaced and the MCP stage updated, and the `mcpInvokeUrl` output removed (no replacement of the `RestApi`, domain or stages).
- [ ] 5.3 After `pnpm exec nx run infra:up` (by the maintainer): the custom domain's `/.well-known/oauth-protected-resource/mcp` answers `200`, the MCP `execute-api` URL answers `403`, `get-stage` shows `*/*`, `token/POST` and `register/POST` with their own values on the MCP stage and `*/*` on the ingestion stage, and Claude Code reconnects to the MCP server and runs a tool without a `429`.
