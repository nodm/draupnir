# mcp-oauth-discovery Specification

## Purpose
Lets an MCP client (Claude Desktop, claude.ai, Claude Code and similar) find
how to authenticate to the Draupnir MCP server, register itself, and obtain a
token the server accepts, without the user handing it a token by hand. Sign-in
stays Google-only through the existing Cognito user pool.

## Requirements

### Requirement: An unauthenticated MCP request is answered with a discovery challenge
A request to the MCP endpoint without a valid token SHALL receive a `401`
response whose `WWW-Authenticate` header uses the `Bearer` scheme and carries a
`resource_metadata` parameter with the absolute URL of the protected resource
metadata document.

#### Scenario: No token
- **WHEN** a request to the MCP endpoint carries no Authorization header
- **THEN** the response is `401` and its `WWW-Authenticate` header names the
  protected resource metadata URL

#### Scenario: Invalid or expired token
- **WHEN** a request to the MCP endpoint carries a malformed, expired, or
  wrong-pool token
- **THEN** the response is `401` with the same challenge

### Requirement: Discovery works from the MCP URL's origin
The MCP endpoint SHALL be served on a stable custom domain, and the protected
resource metadata and authorization server metadata SHALL be served at the
well-known paths of that domain's origin, so a client that probes the origin
without the challenge finds them.

#### Scenario: Probing the origin
- **WHEN** an unauthenticated client requests
  `/.well-known/oauth-protected-resource/mcp` and then
  `/.well-known/oauth-authorization-server` on the MCP domain
- **THEN** both respond `200` JSON

#### Scenario: Root fallback
- **WHEN** an unauthenticated client requests `/.well-known/oauth-protected-resource`
  on the MCP domain
- **THEN** the same protected resource metadata is returned

### Requirement: Protected resource metadata names the MCP server and its authorization server
The server SHALL serve, without authentication, a JSON protected resource
metadata document (RFC 9728) whose `resource` is the MCP endpoint's URL and whose
`authorization_servers` lists the issuer that serves the authorization server
metadata below.

#### Scenario: Metadata is fetched without credentials
- **WHEN** an unauthenticated client requests the protected resource metadata URL
- **THEN** the response is `200` JSON with `resource` equal to the MCP endpoint URL
  and a non-empty `authorization_servers`

### Requirement: Authorization server metadata supports a standard client flow
The server SHALL serve, without authentication, OpenID Connect discovery
metadata for the advertised issuer. The document's `issuer` SHALL equal the
advertised issuer, and it SHALL give an authorize endpoint and a token endpoint
on the MCP origin that hand over to the user pool, the user pool's JWKS
endpoint, `S256` as a supported PKCE method, the authorization code grant,
public clients (no client authentication), and a `registration_endpoint`.

#### Scenario: Metadata is fetched without credentials
- **WHEN** an unauthenticated client requests the discovery metadata
- **THEN** the response is `200` JSON whose `issuer` equals the issuer named in
  the protected resource metadata, whose `code_challenge_methods_supported`
  includes `S256`, and which includes `registration_endpoint`

#### Scenario: Sign-in is Google only
- **WHEN** a client follows the advertised authorize endpoint
- **THEN** the user signs in through the user pool's Google sign-in, and no
  username and password sign-in is offered

### Requirement: A client can register itself for allowlisted redirect URIs
The registration endpoint SHALL accept an unauthenticated JSON request (RFC 7591
shape) listing `redirect_uris` and SHALL respond `201` with a `client_id` of a
public client (no secret) that is permitted the authorization code grant, PKCE,
the `openid` scope, and exactly those redirect URIs. A redirect URI is allowed
only if it is the claude.ai or claude.com MCP callback, or an `http` loopback
(`localhost` or `127.0.0.1`) callback with a port and path. Registering the same
set of redirect URIs again SHALL return the same `client_id`.

#### Scenario: Allowlisted registration
- **WHEN** a client registers with the claude.ai MCP callback URI
- **THEN** the response is `201` with a `client_id`, the same `redirect_uris`,
  and no `client_secret`

#### Scenario: Loopback callback with any port
- **WHEN** a client registers with `http://127.0.0.1:<port>/callback` for a port
  it chose
- **THEN** the response is `201` and the authorization flow for that `client_id`
  accepts that exact redirect URI

#### Scenario: Registration is idempotent
- **WHEN** the same client registers twice with the same redirect URIs
- **THEN** both responses carry the same `client_id` and only one app client exists

#### Scenario: Other redirect URIs are refused
- **WHEN** a client registers with a redirect URI that is not allowlisted (for
  example an `https` URL on another host, or an `http` URL on a non-loopback host)
- **THEN** the response is a `400` registration error (`invalid_redirect_uri`) and
  no client is created

### Requirement: Registration is bounded
The registration endpoint SHALL be rate limited and SHALL stop creating new
clients once a fixed maximum number of registered clients exists, answering
with an error instead. Registered clients SHALL be identifiable as created by
registration and SHALL NOT be allowed any scope other than `openid`, `email`
and `profile`.

#### Scenario: Client cap reached
- **WHEN** the maximum number of registered clients already exists and a client
  registers with a new set of redirect URIs
- **THEN** the response is an error and no client is created

#### Scenario: Cap does not block known clients
- **WHEN** the maximum number of registered clients exists and a client registers
  with a set of redirect URIs that is already registered
- **THEN** the existing `client_id` is returned

### Requirement: A registered client's token is accepted by the MCP endpoint
A user who completes the authorization code flow with a registered client SHALL
obtain an access token that the MCP endpoint accepts and that identifies the same
user (`sub`) as the user's other sign-ins. The `resource` parameter that MCP
clients send on authorization and token requests SHALL NOT cause those requests
to fail.

#### Scenario: Connect end to end
- **WHEN** a client registers, completes the flow with a Google sign-in, and calls
  `tools/list` with the resulting access token
- **THEN** the call succeeds and the data tools run as that user

#### Scenario: `resource` is sent
- **WHEN** a client includes the MCP endpoint URL as `resource` on the authorize
  and token requests
- **THEN** the flow completes normally

#### Scenario: Authorize requests are redirected without `resource`
- **WHEN** a client opens the advertised authorize endpoint with `resource`
- **THEN** it is redirected to the user pool's authorize endpoint with the same
  parameters except `resource`

#### Scenario: Token requests are forwarded without `resource`
- **WHEN** a client posts a token request with `resource` to the advertised token
  endpoint
- **THEN** the request reaches the user pool without `resource`, the user pool's
  response is returned without its `id_token` (a token that would also
  authenticate against the other APIs), and only the authorization code and
  refresh token grants are forwarded

### Requirement: The audience deviation is stated
The system SHALL document that tokens are not audience-bound to the MCP server
(the user pool does not honor `resource`), so the MCP endpoint relies on the
user pool's signature, issuer and scope checks and not on an audience check.

#### Scenario: Deviation is recorded
- **WHEN** a reader looks up how the MCP server validates token audience
- **THEN** the ADR for MCP client authorization states the deviation and why it
  is accepted

### Requirement: The unauthenticated OAuth routes are throttled
Every unauthenticated OAuth route on the MCP origin (the protected resource
metadata, the authorization server and OpenID Connect discovery metadata, the
authorize endpoint, the token endpoint and the registration endpoint) SHALL have a
throttle, so that no route can invoke the OAuth Lambda function at the account's
default rate. The discovery documents and the authorize endpoint SHALL use the MCP
stage's default (10 requests per second, burst 20). The token endpoint SHALL keep
its own limit of 5 requests per second with a burst of 10, and the registration
endpoint its own limit of 1 request per second with a burst of 5; these stricter
limits SHALL take precedence over the stage default for those two methods.

#### Scenario: A flood on a discovery document is throttled
- **WHEN** requests to `/.well-known/oauth-protected-resource/mcp` arrive faster
  than 10 per second beyond a burst of 20
- **THEN** the excess requests are answered `429` and do not invoke the OAuth
  Lambda function

#### Scenario: The token endpoint keeps its stricter limit
- **WHEN** requests to `POST /token` arrive faster than 5 per second beyond a burst
  of 10
- **THEN** the excess requests are answered `429`, even though the stage default
  would have allowed them

#### Scenario: The registration endpoint keeps its stricter limit
- **WHEN** requests to `POST /register` arrive faster than 1 per second beyond a
  burst of 5
- **THEN** the excess requests are answered `429` and no app client is created for
  them
