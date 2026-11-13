## Why

The MCP and ingestion REST APIs have almost no cost and capacity guardrails. On the MCP stage only
`token/POST` (5 rps, burst 10) and `register/POST` (1 rps, burst 5) are throttled. The other
unauthenticated OAuth routes (the four `/.well-known/*` documents and `GET /authorize`) fall back to
the account default of about 10,000 rps, and every one of those requests invokes the `mcp-oauth`
Lambda. The ingestion stage has no throttle at all. A flood on either API is billed per request
and can use every one of the account's 10 concurrent Lambda executions, which throttles the
Telegram bot, the queue consumers and the Cognito pre-sign-up trigger as well (see
`docs/architecture.md`, Concurrency). The MCP API also still answers on its default
`execute-api` URL, which is a second public entry point now that `mcp.draupnir.nodm.name` serves
everything clients use.

## What Changes

- MCP stage: a stage-wide default throttle for every method (`*/*`, rate 10, burst 20). The
  stricter `token/POST` and `register/POST` limits stay and still apply to those two methods.
- Ingestion stage: a stage-wide default throttle for every method (`*/*`, rate 5, burst 10),
  sized for the two users.
- MCP REST API: the default `execute-api` endpoint is turned off, so the API is reachable only
  through `https://mcp.draupnir.nodm.name`. The stage is redeployed so the change takes effect.
  **BREAKING** for anything that still calls the `execute-api` URL; none was found (see Impact).
- The `mcpInvokeUrl` stack output and the `McpApi.invokeUrl` field are removed; `mcpUrl` remains
  the one MCP address.
- Docs: `infra/README.md` gets a section on the API guardrails; `docs/architecture.md` and
  ADR-0012 stop saying the `execute-api` URL stays enabled and that nothing limits the public
  routes.
- Not in scope: AWS WAF (per-IP rate rules). It has its own monthly charge; it is recorded in
  design.md as a later option only. The Telegram bot API is unchanged (it already has a `*/*`
  throttle and needs its `execute-api` URL for the webhook and the login callback).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-server-api`: the MCP API is served only on its custom domain, and every method of its
  stage has a default throttle.
- `mcp-oauth-discovery`: the unauthenticated discovery and authorize routes are throttled by the
  stage default; token and registration keep their stricter limits, which override the default.
- `user-authentication`: the ingestion API (whose authenticated routes this capability covers)
  has a default throttle on every method.

## Impact

- Code: `infra/lib/mcpApi.ts` (default `MethodSettings`, `disableExecuteApiEndpoint`, redeploy
  trigger, `invokeUrl` removed), `infra/lib/ingestionApi.ts` (default `MethodSettings`),
  `infra/index.ts` (`mcpInvokeUrl` export removed).
- Tests: the whole-program Pulumi mock test in `infra/src/concurrency.spec.ts` gains assertions on
  the throttles and the disabled endpoint.
- Users of the `execute-api` URL: none found. The search covered the stack exports, `mcp/README.md`
  (which already gives the custom domain to Claude Code, Claude Desktop and claude.ai), the
  READMEs, `docs/`, the open `add-bot-ai-chat` change, scripts and tests. The connector setup
  uses only `https://mcp.draupnir.nodm.name/mcp`.
- Clients: callers over a limit get API Gateway's `429 Too Many Requests` instead of a Lambda
  invocation. The `execute-api` URL answers `403 Forbidden`.
- Cost: no new paid resources.
