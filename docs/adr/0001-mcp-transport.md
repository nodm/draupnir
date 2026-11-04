# ADR-0001: MCP Server Transport Model

## Status

Accepted

## Date

2026-08-22

## Deciders

Dmytro Novikov

## Context

Draupnir's MCP server exposes transaction/account data as MCP tools/resources for
analysis by Claude (Desktop/Code) and possibly a future custom Agent SDK or Mastra
app. It must be reachable by **two independent Cognito-authenticated users** (me +
wife) from **multiple devices**, not just one local machine. This rules out a purely
local stdio deployment as the primary transport.

The current MCP spec (**2026-07-28**, final — supersedes 2025-11-25) defines exactly
two standard transports:

- **stdio** — client launches the server as a local subprocess; single-user,
  single-machine by construction. Clients *should* support it, but it cannot satisfy
  the multi-user/multi-device requirement on its own.
- **Streamable HTTP** — a single HTTP endpoint that accepts `POST` only. Every
  JSON-RPC request is its own POST; the server answers with either one JSON object
  or an SSE stream *scoped to that request*. As of this revision the protocol is
  **stateless by design, not by configuration**: `Mcp-Session-Id`, the standalone
  `GET` SSE stream, and `Last-Event-ID` resumability were all **removed** (they
  existed in 2025-03-26 through 2025-11-25, but "none of these mechanisms are part
  of this revision"). Any request can land on any server instance behind a plain
  round-robin load balancer with no shared session storage.
  ([spec: Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http))

  Two things this revision adds that matter for our shape of server:
  - **Multi Round-Trip Requests (MRTR)** replace server-initiated requests
    (sampling/elicitation/roots). Instead of holding a connection open, the server
    returns an `InputRequiredResult` and the client re-POSTs the same call with
    `inputResponses`. Interactive tool flows no longer need a long-lived connection
    or server-held state between the two POSTs.
  - Long-lived server push (e.g. `notifications/resources/updated`) is still
    possible, but only via a `subscriptions/listen` POST whose *response* is a
    long-lived SSE stream — not via the removed GET endpoint.
  - Required `Mcp-Method`/`Mcp-Name` headers mirror body fields onto HTTP headers
    specifically so gateways/WAFs can route and meter per-tool without parsing the
    JSON body — a direct fit for API Gateway request validation/throttling later.

  I originally drafted this ADR against the 2025-06-18 spec, where session support
  (`Mcp-Session-Id`) was *optional* and "stateless" was a deployment choice made at
  the SDK level (`sessionIdGenerator: undefined`). That's now moot: 2026-07-28 makes
  statelessness the only mode there is. This doesn't change the decision below, it
  removes the one place it was hedged.

The compute question was whether Lambda's request/response model fits Streamable
HTTP cleanly, or whether MCP's streaming semantics push toward an always-on option
(Fargate). One AWS fact changed the calculus from what older (pre-Nov-2025) posts
assume:

- **API Gateway REST APIs now support native response streaming** (`ResponseTransferMode:
  STREAM`, GA Nov 2025). With it enabled, the integration timeout extends from 29s
  up to **15 minutes** (matching Lambda's own max), and SSE passes through the
  gateway instead of being buffered. HTTP APIs (the cheaper API Gateway variant)
  still do **not** support streaming — only REST APIs do.
  ([AWS what's new](https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis),
  [docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html))

The TypeScript SDK supports 2026-07-28 as of its release, so there's no lag forcing
us onto an older protocol version to get SDK support.

REST API's `COGNITO_USER_POOLS` authorizer validates Cognito JWTs and injects claims
per-request natively — no custom Lambda authorizer needed — which maps directly onto
"two independent Cognito identities, each request self-authenticates."

## Decision

Run the MCP server as an **AWS Lambda function behind an API Gateway REST API**,
implementing the **2026-07-28 Streamable HTTP transport** (stateless — no session
ID, no GET stream, no resumability, per spec), authenticated by a native
**Cognito User Pool authorizer** on the REST API.

- Every tool call is a self-contained `POST` to the MCP endpoint; the Cognito JWT
  on each request identifies which user's transaction/account data to scope the
  call to. No session affinity, no server-held session state between requests.
- Response streaming (`ResponseTransferMode: STREAM`) is left available at the
  REST API level but not turned on by default — most tool calls (query
  transactions, categorize spend, summarize) are short synchronous request/response
  exchanges that don't need server-initiated push. It's a config flip, not a
  re-architecture, if a slow tool call needs to exceed the default timeout or
  stream partial results later.
- Local stdio remains supported *in addition*, for ad hoc local development against
  Claude Desktop/Code — it is not the deployment path for day-to-day multi-device use.

## Options Considered

| Option | Complexity | Cost | Scalability | Fit for requirement |
|---|---|---|---|---|
| Local stdio only | Lowest | $0 | None — single machine/process | Fails multi-user/multi-device requirement outright |
| Lambda + API Gateway REST (Streamable HTTP, stateless) | Low — fits existing Pulumi/TS IaC, no new compute primitives | Lowest — pay-per-request, ~$0 idle for 2 users | Trivial — stateless, scales to zero and out automatically | Good — Cognito authorizer native, streaming available if needed later |
| Lambda + API Gateway HTTP API | Low | Lowest | Trivial | Cheaper JWT authorizer, but **no response streaming** at all — permanently rules out SSE/push even as a later upgrade |
| Always-on Fargate + ALB (stateful sessions) | Higher — ECS service, task defs, VPC networking, ALB, health checks | Highest — fixed ~$25–45+/mo running 24/7 for 2 occasional users | Manual/auto-scaling config required | Best session/streaming fidelity, but overkill for current load pattern |

## Trade-off Analysis

- **Cost vs. fidelity**: Fargate buys full stateful sessions and unconstrained
  long-lived SSE, but that fidelity is wasted on two users making occasional,
  mostly-synchronous tool calls. Lambda's near-zero idle cost is the dominant
  factor for a personal project.
- **Cold starts**: Node.js Lambda cold starts (~200–500ms, worse if VPC-attached
  for DB access) are acceptable given that interactive LLM tool-calling round trips
  already run multi-second; this isn't the bottleneck in the user-perceived latency
  budget. Provisioned concurrency is available later if it becomes one.
- **REST API vs. HTTP API**: HTTP API is cheaper and has a simpler native JWT
  authorizer, but permanently forecloses response streaming. Paying the small
  extra REST API cost/complexity now avoids a forced migration later if a tool call
  needs to stream (e.g., a long analysis job). This is the one place we spent
  more than the minimum for optionality.
- **Statelessness is no longer a choice we're making — it's the spec.** 2026-07-28
  removed sessions and resumable streams from Streamable HTTP outright, so there's
  no shared-session-storage design question to hedge on. Interactive flows that
  used to need an open connection (sampling/elicitation) now round-trip via MRTR's
  `InputRequiredResult` + re-POST, which fits Lambda's request/response model even
  better than the 2025-06-18 "optional session" version did. The one thing genuinely
  lost vs. earlier revisions is resumable delivery on disconnect — acceptable for
  synchronous tool calls; a `subscriptions/listen` long-lived stream (if we ever
  need server-initiated push for e.g. new-transaction alerts) has no resumability
  either, so that's a wash, not a regression we're choosing.

## Consequences

- MCP server code cannot assume any in-memory state survives between calls — the
  spec itself guarantees no session/instance affinity, not just our deployment
  choice. Any state a tool call needs across requests (e.g. an MRTR round-trip's
  original params) must be reconstructed from the request body each time or
  persisted externally (DB), not held in Lambda memory.
- Any future requirement for server-initiated push (e.g. new-transaction alerts
  via `subscriptions/listen`) will need either: (a) turning on REST API response
  streaming + SSE for that route, or (b) revisiting this ADR toward Fargate if a
  long-lived listen stream's cost/duration profile doesn't fit Lambda well.
- Per-user data scoping depends entirely on trusting the Cognito-authorizer-injected
  claims on each request; the Lambda handler must never accept a user/account
  identifier from the request body/tool arguments for authorization purposes.
- Pulumi IaC needs: Lambda function, API Gateway REST API + `COGNITO_USER_POOLS`
  authorizer, and existing Cognito user pool wired as the authorizer's provider.

## Action Items

- [ ] Scaffold the MCP server package (nx) on `@modelcontextprotocol/sdk`
      targeting protocol version 2026-07-28 (confirm current SDK version pins this
      before scaffolding — re-check, don't assume from this ADR).
- [ ] Add Pulumi resources: Lambda function, API Gateway REST API, Cognito User
      Pool authorizer wired to the existing user pool.
- [ ] Confirm Lambda handler scopes all data access to the authorizer-injected
      Cognito `sub`/user claim, never to client-supplied identifiers.
- [ ] Document local stdio dev flow for Claude Desktop/Code against the same
      server code, for local iteration without deploying.
- [ ] Design how MRTR round-trips (`InputRequiredResult` → re-POST with
      `inputResponses`) reconstruct in-progress tool state without server-held
      session memory — likely re-derive from the retried params, not a DB lookup,
      unless a tool genuinely needs server-side partial-computation state.
- [ ] Revisit this ADR if/when a tool needs server-initiated push via
      `subscriptions/listen` — evaluate turning on REST API response streaming for
      that route before reconsidering Fargate.
- [ ] Separate ADR: OAuth/client-registration flow for Claude Desktop↔Cognito.
      2026-07-28 deprecates Dynamic Client Registration in favor of Client ID
      Metadata Documents and adds RFC 9207 issuer validation — check how this maps
      onto Cognito's (typically static app-client) OAuth model before assuming the
      existing user pool config works as-is.
