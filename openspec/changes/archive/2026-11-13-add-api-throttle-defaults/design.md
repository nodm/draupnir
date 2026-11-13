## Context

See proposal.md for the motivation. The facts the design depends on:

- **Three REST APIs, one throttle pattern.** `infra/lib/bot.ts` sets one `MethodSettings` with
  `methodPath: '*/*'` (rate 10, burst 20) on the bot stage. `infra/lib/mcpApi.ts` has only two
  method-level settings, `token/POST` (5/10) and `register/POST` (1/5). `infra/lib/ingestionApi.ts`
  has none.
- **The MCP API's methods.** `POST /mcp` (Cognito authorizer, `mcp` Lambda) and seven
  unauthenticated methods on the `mcp-oauth` Lambda: `GET /.well-known/oauth-protected-resource`,
  `GET /.well-known/oauth-protected-resource/mcp`, `GET /.well-known/oauth-authorization-server`,
  `GET /.well-known/openid-configuration`, `GET /authorize`, `POST /token`, `POST /register`.
- **The ingestion API's methods.** `GET /whoami`, `POST /accounts`, `POST /uploads`, all behind the
  Cognito authorizer.
- **Lambda concurrency.** The account quota is 10 concurrent executions (`docs/architecture.md`,
  `cost-guardrails`). The queue consumers can use at most 6; nothing limits the API-invoked
  functions individually.
- **Custom domain.** `mcp.draupnir.nodm.name` is mapped to the MCP stage with a `BasePathMapping`.
  The `execute-api` URL still works and is exported as `mcpInvokeUrl`. ADR-0012 says it "stays
  enabled" and leaves the move of the other APIs to a separate change.
- **Redeploys.** Each API's `Deployment` is replaced when the JSON in `triggers.redeployment`
  changes; the comments in `ingestionApi.ts` explain why it hashes configuration, not resource ids.

## Goals / Non-Goals

**Goals:**

- Put an upper bound, set in code, on the request rate every method of the MCP and ingestion
  stages accepts, so a flood costs a bounded amount and leaves Lambda capacity for the rest of the
  system.
- One public address for the MCP API.

**Non-Goals:**

- Per-client or per-IP limits. API Gateway stage throttles are shared by all callers of a method;
  per-IP rate rules need AWS WAF (see Decision 6).
- Usage plans and API keys. MCP clients and the ingestion callers authenticate with Cognito tokens,
  not API keys.
- The bot API. It already has its `*/*` throttle, and its `execute-api` URL is the Telegram webhook
  and the login callback.
- Disabling the ingestion API's `execute-api` endpoint. It has no custom domain yet, so that URL
  is its only address.

## Decisions

### 1. A `*/*` `MethodSettings` per stage, as in `bot.ts`

Each stage gets one more `aws.apigateway.MethodSettings` resource with `methodPath: '*/*'`. This
is how the bot API already does it, and it covers every method that exists now or is added later
without listing them.

Alternatives: one `MethodSettings` per method (has to be kept in step with the routes; a new route
would be unthrottled by default, which is the gap this change closes); a usage plan with a
throttle (applies only to requests with an API key, which these clients don't send).

### 2. The limit applies per method, not to the stage as a whole

API Gateway's stage default (`*/*`) is the default limit for each method of the stage. Each method
has its own token bucket; the limit is not shared across the stage. So the stage's total
ceiling is the sum over its methods:

| Stage     | Methods on the default | Default | Overrides           | Total rate ceiling | Total burst |
| --------- | ---------------------- | ------- | ------------------- | ------------------ | ----------- |
| MCP       | 6                      | 10 / 20 | token 5/10, reg 1/5 | 66 rps             | 135         |
| Ingestion | 3                      | 5 / 10  | none                | 15 rps             | 30          |

These ceilings are what the docs state, not the per-method numbers alone. They are still about
150 times (MCP) and 650 times (ingestion) lower than the account's default of 10,000 rps. Throttling
is also applied by API Gateway on a best-effort basis, so short overshoots are possible. The specs
say "each method separately" so that a test or a reader doesn't assume a shared stage bucket.

### 3. MCP: rate 10, burst 20

What an MCP client sends when it connects, per method:

- Discovery: one `POST /mcp` without a token (the authorizer answers `401`; no Lambda runs), then
  `GET /.well-known/oauth-protected-resource/mcp`, maybe the root fallback
  `/.well-known/oauth-protected-resource`, then `oauth-authorization-server` and/or
  `openid-configuration`. That is one or two requests per discovery method, each on a different
  method.
- Registration: one `POST /register` (idempotent for a known set of redirect URIs).
- Sign-in: one `GET /authorize`, then one `POST /token` after the Google sign-in. A refresh is one
  more `POST /token`.
- Session start: `initialize`, `notifications/initialized` and `tools/list` on `POST /mcp`, within
  about a second; a client may also send `prompts/list` or `resources/list`, so up to about 5.
- Use: tool calls on `POST /mcp`. Claude can issue several tool calls in one turn, sometimes in
  parallel, so a few requests in the same second, then pauses while the model works.

The busiest method is `POST /mcp`. Two users with up to three clients each (Claude Code, Claude
Desktop, claude.ai) all reconnecting at once, for example after a deploy, would send about
6 × 5 = 30 requests over a few seconds: the burst of 20 takes the first second and the rate of 10
the rest, with no `429`. In normal use a single session sends well under 1 rps on average. Every
other method sees at most 2 requests per client per connect, far under 10/20.

Upward bound: a saturated `POST /mcp` at 10 rps is 864,000 accepted requests a day. At about
$3.50 per million REST API requests that is about $3 a day for API Gateway, plus the Lambda
invocations. That is enough to notice in the bill and alarms, and far from the account default.
10 rps is also the limit that keeps the MCP API from taking all of the Lambda concurrency in
normal conditions: the `mcp-oauth` function answers in tens of milliseconds, so 6 methods at 10 rps
need about 1–2 concurrent executions; see the Risks section for `POST /mcp` while Aurora resumes.

The same numbers as the bot API: one rule for the public-facing stages, easy to remember.

Alternatives: 5/10 (too close to a multi-client reconnect on `POST /mcp`); 50/100 (no longer
stops a flood from using all 10 Lambda executions or from adding to the bill quickly).

### 4. Ingestion: rate 5, burst 10

The ingestion API has two users and only interactive callers: `whoami`, creating an account, and
asking for upload URLs, one per CSV file. A user who uploads a handful of statements at once asks
for a handful of URLs in a row; burst 10 covers that and rate 5 covers a longer series. The Cognito
authorizer already rejects requests without a valid token before any Lambda runs, but API Gateway
still bills those requests, and a valid token in a loop still reaches `accounts` and `uploads`,
which wake Aurora. Throttling is checked before the authorizer, so it limits both cases.

Alternative: the MCP/bot numbers (10/20). Not needed for this traffic; half is still several times
the real peak and halves the ceiling.

### 5. The method-level overrides take precedence over `*/*`

For REST APIs, a `MethodSettings` entry for a specific `resource/METHOD` path overrides the
stage-wide `*/*` entry for that method; the `*/*` values apply only to methods without their own
entry. This is documented in API Gateway's "Throttle requests to your REST APIs" (method-level
throttling overrides the stage-level default) and in the provider's `MethodSettings` docs
(`*/*` overrides all methods in the stage, a specific path overrides that method). So
`token/POST` stays at 5/10 and `register/POST` at 1/5. Each `MethodSettings` resource patches only
its own path in the stage's settings, so the three MCP resources don't overwrite each other.

The override values stay where they are; the token limit gets a named constant like the register
limit, and the new default gets one too (`DEFAULT_THROTTLE`), so all three are read side by side.
Task 4.1 checks the precedence on the deployed stage with `aws apigateway get-stage`, where
`methodSettings` lists `*/*`, `token/POST` and `register/POST` with their own values.

### 6. Disable the MCP `execute-api` endpoint, and redeploy

`RestApi` gets `disableExecuteApiEndpoint: true`. API Gateway applies this setting only after the
API is deployed again, so the value is added to the MCP `Deployment`'s `triggers.redeployment`
JSON (`restApi.disableExecuteApiEndpoint`). Changing it replaces the Deployment and points the
stage at the new one, as for any route change. The custom domain is unaffected: it maps to the
stage, not to the `execute-api` host. The Lambda permissions use `restApi.executionArn`, which is
also the ARN of requests through the custom domain, so they don't change.

With the endpoint off, the stage's `invokeUrl` is an address that answers `403`. It is removed
from the `McpApi` interface and the `mcpInvokeUrl` export is removed, so no one is pointed at it.
`mcpUrl` stays. `ingestionInvokeUrl` stays, since the ingestion API keeps its endpoint.

Search for users of the URL (done for this proposal): `infra/index.ts` exports it; nothing in the
repository reads `mcpInvokeUrl` (`infra/scripts/reset-data.sh` reads other outputs); `mcp/README.md`
gives only `https://mcp.draupnir.nodm.name/mcp` for Claude Code, Claude Desktop and claude.ai; the
other docs, the open `add-bot-ai-chat` change and the tests don't use it. Two texts state the
opposite and are updated: the comment above the custom domain in `mcpApi.ts` ("The execute-api URL
keeps working") and ADR-0012's consequence ("The `execute-api` URL stays enabled").

Alternatives: keep the endpoint and throttle it (same stage, so same limits, but still two
addresses to document and two hosts that reach the Lambdas); a resource policy that denies the
`execute-api` host (more code, same effect).

### 7. WAF only as a later option

AWS WAF with a rate-based rule could limit each IP separately, so one caller flooding a route
would not use up the stage throttle for the real users. A web ACL has a fixed monthly charge plus
a charge per rule and per million requests, more than this project's API traffic costs now. It is
recorded in `infra/README.md` as the next step if a flood ever locks the users out, not built.

### 8. Tests in the whole-program mock test

`infra/src/concurrency.spec.ts` already runs the whole Pulumi program against recorded mocks and
pins the `cost-guardrails` concurrency limits. The throttles and the disabled endpoint are the same
kind of guardrail, so they get a new `describe` block there instead of a second copy of the
~100-line mock set-up. The file is renamed to `guardrails.spec.ts` and its header comment updated
to name both. The block asserts:

- the `MethodSettings` set per REST API: `mcp` has `*/*` 10/20, `token/POST` 5/10 and
  `register/POST` 1/5; `ingestion` has `*/*` 5/10; `bot` keeps `*/*` 10/20;
- every `RestApi` has a `*/*` default, so a new API without one fails the test;
- the `mcp` `RestApi` has `disableExecuteApiEndpoint: true`, and the MCP `Deployment`'s
  redeployment trigger includes that value.

Precedence itself is API Gateway's behaviour and can't be shown with mocks; Decision 5's deploy
check covers it.

## Risks / Trade-offs

- [A flood from one caller throttles the real users too, since limits are per method, not per
  caller] → Accepted: the guardrail's job is to bound cost and protect Lambda capacity for the
  bot and the queues. Recovery is automatic when the flood stops. WAF (Decision 7) is the fix if
  it ever happens.
- [10 rps on `POST /mcp` can still use all 10 Lambda executions while Aurora resumes: each
  request then waits up to 29 s] → Not made worse by this change (it was unbounded before). The
  account quota is the ceiling for concurrency; this change bounds request count. Revisit with the
  `cost-guardrails` quota note if the quota changes.
- [The throttle is too tight for a real client's connect burst] → `429` is visible in the client
  and in API Gateway's `4XXError` metric; raise the constant. Decision 3's sizing leaves about 3×
  headroom over a simultaneous reconnect of every client.
- [Something outside the repository uses the MCP `execute-api` URL (a saved connector, a bookmark)]
  → It gets `403`. The connector setup in `mcp/README.md` has used the custom domain since it
  existed. Rollback is `disableExecuteApiEndpoint: false` and a deploy.
- [Per-method limits add up to more than the per-method number suggests] → Decision 2's table goes
  into `infra/README.md`.

## Migration Plan

1. Deploy with `pnpm exec nx run infra:up`. The preview should show: two new `MethodSettings`
   (MCP `*/*`, ingestion `*/*`), the MCP `RestApi` updated in place, the MCP `Deployment` replaced
   and the stage updated, and the `mcpInvokeUrl` output removed.
2. Check: `curl -i https://mcp.draupnir.nodm.name/.well-known/oauth-protected-resource/mcp` → `200`;
   the old `execute-api` URL (from the previous output, or the API id) → `403`;
   `aws apigateway get-stage` for both stages shows the expected `methodSettings`.
3. Reconnect Claude Code to the MCP server and run a tool, to confirm a real connect isn't
   throttled.

Rollback: revert the commit and deploy. The `MethodSettings` resources are deleted, and setting
`disableExecuteApiEndpoint` back to `false` changes the trigger and redeploys the stage.
