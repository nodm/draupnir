## Why

ADR-0001 (`docs/adr/0001-mcp-transport.md`) decided the MCP server runs as a Lambda
behind an API Gateway REST API with a native Cognito authorizer, but left "add
Pulumi resources: Lambda function, API Gateway REST API, Cognito User Pool
authorizer" as an unchecked action item. `add-auth-authz-layer`'s task 2.3 (attach
the Cognito authorizer to `mcp`'s REST API) was explicitly deferred for the same
reason: the API didn't exist yet to attach anything to. The `mcp` Nx app itself was
scaffolded in `scaffold-nx-monorepo` but still only exports a placeholder `mcp()`
function and a no-op handler — there is no deployed endpoint at all.

## What Changes

- Provision `mcp`'s base infrastructure in Pulumi: a Lambda function behind a
  regional API Gateway REST API, with the same Cognito User Pool authorizer
  (`ingestion`'s user pool, per ADR-0001) attached to its route(s).
- Implement a minimal Streamable HTTP (MCP spec 2026-07-28) POST endpoint whose
  handler reads the authorizer-injected `sub` claim and returns it in a
  JSON-RPC-shaped response — enough to prove the auth + transport wiring works
  end-to-end. No MCP tools/resources for transaction/account data yet; that is a
  separate follow-up change once this base layer is deployed and verified.
- Reuses `infra/lib/ingestionApi.ts`'s existing `createLambdaRoute` pattern
  (regional REST API, `COGNITO_USER_POOLS` authorizer, deployment-trigger hash)
  rather than introducing a new IaC shape.

## Capabilities

### New Capabilities
- `mcp-server-api`: the deployed MCP Lambda + API Gateway REST API, its Cognito
  authorizer wiring, and the minimal Streamable HTTP endpoint that authenticates a
  request and identifies the caller from the injected claim.

### Modified Capabilities
(none — no existing capability's requirements change)

## Impact

- `infra/`: new `infra/lib/mcpApi.ts` (or an extension of the existing route
  helper) provisioning the Lambda, REST API, and authorizer; `infra/index.ts` wires
  it up and exports the new API's id/invoke URL.
- `mcp/`: `mcp/src/handler.ts` replaces the no-op handler with a Streamable HTTP
  POST handler; `mcp/src/lib/mcp.ts`'s placeholder `mcp()` export is removed once
  no longer referenced.
- No changes to `ingestion`'s API, schema, or data.
