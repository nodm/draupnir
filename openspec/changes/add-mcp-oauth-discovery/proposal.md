## Why

`add-mcp-data-tools` put the data tools on the deployed `/mcp` endpoint, but
Claude Desktop, claude.ai and Claude Code cannot connect to it on their own. A
client needs a Cognito token that the user obtains by hand through the PKCE
flow, and it expires after about an hour. MCP clients expect to discover the
authorization server from the MCP URL and to register themselves. Cognito does
not offer either: it has no Dynamic Client Registration (DCR), no confirmed
Client ID Metadata Document (CIMD) support, no protected resource metadata, and
it ignores the RFC 8707 `resource` parameter. Without this change the MCP server
is unusable from the clients it was built for.

This is the open item of ADR-0001 and ADR-0002 and the non-goal of
`add-mcp-data-tools`. It takes the "thin shim in front of Cognito" shape named in
ADR-0002, not a full OAuth proxy.

## What Changes

- The unauthenticated `401` from `/mcp` carries a `WWW-Authenticate: Bearer
  resource_metadata="…"` challenge (an API Gateway gateway response).
- A custom domain for the MCP API (a Route53 hostname with an ACM certificate),
  so the MCP URL is `https://<mcp-host>/mcp` and the well-known paths sit at the
  origin root, where clients probe. The `execute-api` URL keeps working.
- New unauthenticated routes on the MCP API, served by one small Lambda:
  - `GET /.well-known/oauth-protected-resource` and its path-suffixed form
    `/.well-known/oauth-protected-resource/mcp`: RFC 9728 metadata naming the
    origin as the authorization server;
  - `GET /.well-known/oauth-authorization-server` and
    `/.well-known/openid-configuration`: authorization server metadata with
    Cognito's authorize, token and JWKS endpoints, `S256` PKCE, and a
    `registration_endpoint`;
  - `POST /register`: DCR-style registration that returns a public Cognito app
    client for the client's redirect URIs.
- `/register` creates (or reuses) a Cognito public app client through
  `CreateUserPoolClient`, only for allowlisted redirect URIs (claude.ai and
  claude.com callbacks, loopback callbacks), with Google as the only identity
  provider, PKCE required, a hard cap on clients created, and throttling.
- The `mcp` route's authorizer switches from ID tokens to **access tokens** (an
  OAuth scope on the method), because MCP clients send the access token.
  **BREAKING:** an ID token no longer authenticates against `/mcp`.
- Documented deviation from the MCP authorization spec: Cognito access tokens
  carry no audience bound to the MCP server (`resource` is accepted and
  ignored), so the server cannot validate an audience as the spec asks.
- Out of scope: a full OAuth proxy, CIMD, refresh-token policy, and changes to
  the primary app API's authorizer.

## Capabilities

### New Capabilities
- `mcp-oauth-discovery`: how an MCP client discovers the protected resource and
  authorization server, registers a client, and obtains a token usable against
  `/mcp`, including the limits on registration.

### Modified Capabilities
- `mcp-server-api`: the authorizer requirement changes to access tokens, and an
  unauthenticated request now receives the discovery challenge.

## Impact

- `mcp/`: a new Lambda entry point for the discovery and registration routes,
  with unit tests. `/mcp`'s handler is unchanged.
- `infra/lib/mcpApi.ts`: the custom domain (ACM certificate validated through
  Route53, regional API Gateway domain name, base path mapping, alias record;
  config keys for the hostname and hosted zone), the unauthenticated routes, a `UNAUTHORIZED` gateway
  response with the challenge header, an OAuth scope on the `/mcp` method,
  throttling on `/register`, and a role allowed `cognito-idp:CreateUserPoolClient`
  and `ListUserPoolClients` on the user pool only.
- Cognito: app clients created by `/register` live outside Pulumi state (named
  with a fixed prefix so they can be listed and removed).
- Records an ADR (`docs/adr/0012-mcp-client-authorization.md`) closing the
  ADR-0001/0002 action items. ADR-0011 is reserved for `add-bot-ai-chat`.
- Existing manual token use (`whoami` checks with an ID token) must switch to an
  access token.
