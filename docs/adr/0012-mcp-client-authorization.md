# ADR-0012: MCP Client Authorization via a Thin OAuth Shim over Cognito

## Status

Accepted

## Date

2026-11-07

## Deciders

Dmytro Novikov

## Context

[ADR-0001](./0001-mcp-transport.md) and [ADR-0002](./0002-auth-request-flow.md) left open how
MCP clients (Claude Desktop, claude.ai, Claude Code) authorize against Cognito. Clients expect to
discover the authorization server from the MCP URL (RFC 9728, RFC 8414/OIDC), register themselves
(DCR or CIMD), and send the RFC 8707 `resource` parameter. Cognito offers none of discovery for
the resource, DCR or `resource` support, and its access tokens carry no audience.

Verified on prod (2026-11-07): Cognito accepts `resource` on `/oauth2/authorize` but then issues a
code that `/oauth2/token` rejects with `invalid_grant`; without `resource` on authorize the flow
works, and `resource` on the token request is harmless only if the authorize request had none.
Cognito also accepts `http://127.0.0.1:<port>` and `http://localhost:<port>` callback URLs.

## Decision

A thin shim on the MCP API, served from a custom domain (`mcp.draupnir.nodm.name`), in front of
Cognito. It is not a full OAuth proxy.

- **Discovery:** `GET /.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`
  and `/.well-known/openid-configuration`. A `401` from `/mcp` carries
  `WWW-Authenticate: Bearer resource_metadata="…"` (an API Gateway gateway response).
- **Registration:** `POST /register` creates (or reuses, by a hash of the sorted redirect URIs) a
  public Cognito app client named `mcp-dcr-<hash>`, Google as the only identity provider, PKCE,
  only for allowlisted redirect URIs (claude.ai and claude.com callbacks, loopback), capped at 25
  clients, throttled, with narrow IAM on the user pool.
- **`GET /authorize`:** a `302` to Cognito's authorize endpoint with `resource` removed.
- **`POST /token`:** forwards `authorization_code` and `refresh_token` grants to Cognito with
  `resource` removed, relays the response without `id_token` (it would authenticate against the other APIs), logs nothing and holds no state.
- **Access tokens:** `/mcp` requires an OAuth scope (`openid`) on the method, so the authorizer
  validates access tokens; an ID token no longer authenticates (breaking).
- **CIMD** is not supported; DCR covers the target clients.

## Deviations and Consequences

- Tokens are not audience-bound to the MCP server (Cognito ignores `resource`), so `/mcp` relies on
  signature, issuer and scope, not an audience check. Compensating controls: the pre-sign-up email
  allowlist, and every tool runs as the caller's `sub` under row-level security.
- `/authorize` and `/token` see codes and tokens in transit. They are small, stateless and
  covered by tests; the alternative (a full proxy with its own callback and token exchange) was
  rejected as the highest-risk code in the system.
- RFC 9207: the metadata does not advertise `authorization_response_iss_parameter_supported`, and
  the redirect to the client is Cognito's own, so the shim adds no `iss`. Per the 2026-07-28 spec
  clients validate `iss` only if present or advertised; not verified against each client.
- Registered clients live outside Pulumi state. A client that uses a new loopback port on each
  login creates a client per port and can exhaust the cap of 25; remove stale clients with:

  ```
  aws cognito-idp list-user-pool-clients --user-pool-id <pool> --max-results 60 \
    --query "UserPoolClients[?starts_with(ClientName,'mcp-dcr-')].ClientId" --output text \
    | xargs -n1 aws cognito-idp delete-user-pool-client --user-pool-id <pool> --client-id
  ```

- The `execute-api` URL stays enabled. Moving the other APIs to `draupnir.nodm.name` is a separate
  change.

## Options Considered

| Option                       | Handles `resource` | Risk                      | Notes                        |
| ---------------------------- | ------------------ | ------------------------- | ---------------------------- |
| **Thin shim (chosen)**       | Strips it          | Small, stateless code     | Verified on prod             |
| Full OAuth proxy             | Yes                | Highest (state, exchange) | Not needed                   |
| Metadata only, manual client | No                 | Low                       | Breaks random loopback ports |

## Action Items

- [ ] Remove or raise the cap if clients are found to exhaust it (see task 4.1 notes).
- [ ] Revisit if Cognito gains DCR, CIMD or `resource` support.
