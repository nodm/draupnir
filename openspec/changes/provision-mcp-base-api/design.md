## Context

`docs/adr/0001-mcp-transport.md` already decided the transport/compute shape:
Lambda behind a regional API Gateway REST API, `COGNITO_USER_POOLS` authorizer on
the existing user pool, Streamable HTTP (2026-07-28, stateless). `infra/lib/ingestionApi.ts`
already implements this exact shape for `ingestion` (`createLambdaRoute`, shared
authorizer, deployment-trigger hash keyed off route config) — this change reuses
that pattern rather than inventing a new one. `mcp/` (the Nx app) exists but
`mcp/src/handler.ts` is a no-op and `mcp/src/lib/mcp.ts` only exports a placeholder
`mcp()` function; neither has been deployed.

See proposal.md - Why/What Changes for motivation and scope.

## Goals / Non-Goals

**Goals:**
- Deploy `mcp`'s Lambda + REST API + Cognito authorizer, mirroring `ingestion`'s
  IaC pattern.
- Ship one minimal Streamable HTTP endpoint that proves auth + transport wiring
  end-to-end (echoes the authorizer-injected `sub` in a JSON-RPC response).

**Non-Goals:**
- No MCP tools/resources for transaction/account data — that's the next change
  once this base layer is verified.
- No response streaming (`ResponseTransferMode: STREAM`) — ADR-0001 leaves it
  available but off by default; nothing in this change's scope needs it.
- No MRTR (`InputRequiredResult` / re-POST) handling — no interactive tool exists
  yet to need it.
- No OAuth/Dynamic Client Registration work for Claude Desktop — ADR-0001 flags
  that as a separate future ADR.

## Decisions

- **Reuse `createLambdaRoute` from `infra/lib/ingestionApi.ts`** rather than
  writing a parallel helper. It already parameterizes name/path/method/handler/
  environment/policy/timeout and takes the REST API + authorizer as arguments,
  so a new `infra/lib/mcpApi.ts` can call it with `mcp`'s own new REST API and a
  new authorizer resource bound to the same user pool. Alternative considered:
  copy-paste a standalone `mcpApi.ts` with its own route-creation code — rejected,
  duplicates the deployment-trigger-hash logic that's already easy to get subtly
  wrong (see the comment in `ingestionApi.ts` about hashing config, not IDs).
- **Own REST API, not a route on `ingestion`'s existing API.** ADR-0001 designed
  `mcp` as its own deployable with its own IAM role/Lambda; sharing `ingestion`'s
  API would couple their deployments and blur the "two independent Cognito users,
  MCP-specific tool surface" boundary the ADR draws. Cost is negligible either
  way (API Gateway REST APIs are effectively free until called).
- **New Cognito `Authorizer` resource, same user pool ARN.** API Gateway
  authorizers are scoped to one REST API each, so `mcp` needs its own
  `aws.apigateway.Authorizer`, but it points at the same `userPool.arn` `ingestion`
  uses — one identity source for both APIs, per ADR-0001's "two independent
  Cognito-authenticated users" framing.
- **Minimal endpoint returns the `sub` claim in a JSON-RPC response, not a real
  MCP method.** The goal here is proving the Lambda receives
  `event.requestContext.authorizer.claims.sub` and that Streamable HTTP's
  request/response shape round-trips through API Gateway's `AWS_PROXY`
  integration — not implementing `initialize`/`tools/list` yet. Using
  `@modelcontextprotocol/server`'s `createMcpHandler` for even this minimal
  endpoint (rather than hand-rolling JSON-RPC parsing) is preferred so the next
  change can add real tools without re-plumbing the transport.
- **`@modelcontextprotocol/server` (v2), not `@modelcontextprotocol/sdk` (v1).**
  Verified via the SDK's own migration docs (`docs/migration/upgrade-to-v2.md`)
  and the npm registry (2026-09-11): the single v1 `@modelcontextprotocol/sdk`
  package is split in v2 into `@modelcontextprotocol/server` /`client`/`core`,
  currently at `2.0.0`. The 2026-07-28 transport is served by v2's
  `createMcpHandler(factory)`, which returns a web-standard `{ fetch(Request):
  Promise<Response> }` handler — there's no official AWS Lambda/API Gateway
  adapter (only `@modelcontextprotocol/node`/`express`/`hono`/`fastify`, none of
  which fit `AWS_PROXY`'s event shape), so `mcp/src/handler.ts` converts the
  `APIGatewayProxyEvent` to a `Request`, calls `handler.fetch`, and converts the
  `Response` back to an `APIGatewayProxyResult` itself. ADR-0001 explicitly
  flagged its own `@modelcontextprotocol/sdk` reference as unconfirmed ("re-check,
  don't assume") — this is that check.

## Risks / Trade-offs

- [Two REST APIs (ingestion + mcp) now need independent deployment/monitoring] →
  Accepted per ADR-0001's decision; the alternative (shared API) was already
  rejected there.
- [Hand-verifying the authorizer/claim wiring only via one minimal endpoint gives
  shallow coverage] → Sufficient for this change's scope (prove wiring, not
  behavior); the follow-up change adding real tools will exercise the same claim
  path more thoroughly through actual data-scoped calls.

## Migration Plan

- New resources only (new REST API, new Lambda, new authorizer); no migration of
  existing `ingestion` resources. Deploy via `pulumi up` against the same stack
  `ingestion` already deploys through (`infra/index.ts` gains new exports:
  `mcpApiId`, `mcpInvokeUrl`).
- Rollback: `pulumi destroy` targeting only the new `mcp` resources, or revert the
  commit and `pulumi up` again — no data migration involved.
