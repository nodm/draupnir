## Why

The OAuth routes on `mcp.draupnir.nodm.name` are public by design: MCP clients discover sign-in and register themselves without a token. Two properties of how they are served cost more than they need to:

- **Every public request runs the OAuth Lambda**, including the four discovery documents, which never change. With the stage default of 10 requests per second on discovery and `/authorize`, an anonymous caller can keep about 56 Lambda-backed requests per second going, indefinitely.
- **Anyone can use up all the client registrations.** `/register` accepts any `http` loopback callback on any port and creates a new app client for each new set of redirect URIs. It creates at most 25 and never deletes one, so anonymous calls with made-up ports can use up the cap within seconds. After that, no new client can connect.

The only clients in use are claude.ai's connectors. Those connectors also cover Claude Desktop, mobile and Claude Code through the claude.ai account. They need neither loopback callbacks nor a Lambda behind the discovery documents.

## What Changes

- **Discovery without a function**: API Gateway answers the four discovery routes directly, with fixed JSON built at deploy time. The routes are `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`. The documents keep their content and their 5-minute `Cache-Control`. The OAuth Lambda no longer handles them.
- **Lower limits on the rarely called routes**: each discovery route and `GET /authorize` gets its own throttle of 1 request per second with a burst of 5 (from the stage default of 10/20). `POST /token` keeps 5/10, `POST /register` keeps 1/5, and `POST /mcp` keeps the stage default of 10/20.
- **BREAKING: registration accepts only the claude.ai and claude.com callbacks.** Loopback (`http://localhost`, `http://127.0.0.1`) redirect URIs are refused with `invalid_redirect_uri`. Only three sets of redirect URIs are possible, so registration can create at most three clients and the cap can no longer be used up. A local client that registers itself, such as `claude mcp add --transport http`, can no longer connect. Claude Code reaches the server through the claude.ai connector instead.
- **One-off cleanup**: after the deploy, delete the two loopback clients created by the 2026-11-07 test (`mcp-dcr-*` with `localhost:33418` and `127.0.0.1:33419` callbacks).
- **Docs**:
  - `mcp/README.md` drops the `claude mcp add` instructions and points to the connector.
  - ADR-0012 gets a dated note: loopback is dropped, and its ID-token deviation was resolved by `remove-ingestion-api`.
  - `infra/README.md` and `docs/architecture.md` get the new limits and ceilings.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `mcp-oauth-discovery`:
  - the discovery documents are served without invoking a function;
  - the throttles on discovery and authorize are lowered;
  - registration is restricted to the claude.ai and claude.com callbacks.

## Impact

- **Code**:
  - The metadata builders move from `mcp/src/lib/oauth.ts` to `infra/lib/mcpOAuthMetadata.ts`, with their tests, because infra now serves the documents.
  - `mcp/src/oauth.ts` drops its four discovery cases.
  - `mcp/src/lib/oauth.ts` drops the loopback rules.
  - `infra/lib/mcpApi.ts` adds MOCK integrations, method and integration responses, and per-method throttles.
  - `infra/src/guardrails.spec.ts` is extended.
- **AWS resources**:
  - The 4 discovery integrations change from Lambda proxy to MOCK, and the 4 discovery methods gain integration and method responses.
  - 5 new `MethodSettings` overrides (the 4 discovery methods and `GET /authorize`).
  - The `mcp` stage is redeployed.
  - Nothing is deleted except the two runtime-created loopback clients, removed by hand.
- **Clients**: claude.ai and claude.com connectors keep working, and their existing client is reused. Loopback-based local clients stop working.
- **Cost**: the anonymous ceiling of Lambda-backed requests falls from about 56 to 7 per second (`/authorize` 1, `/token` 5, `/register` 1). The discovery routes still count as API Gateway requests, but at 1 rps each instead of 10.
