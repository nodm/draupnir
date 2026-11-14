## ADDED Requirements

### Requirement: Discovery documents are served without invoking a function
The protected resource metadata (at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`), the authorization server metadata (`/.well-known/oauth-authorization-server`) and the OpenID Connect discovery metadata (`/.well-known/openid-configuration`) SHALL be answered by API Gateway from content fixed at deploy time, without invoking any Lambda function. Each response SHALL be `200` with `Content-Type: application/json` and `Cache-Control: public, max-age=300`. The documents SHALL have the content that the other requirements of this capability define.

#### Scenario: A discovery request invokes nothing
- **WHEN** an unauthenticated client requests any of the four discovery documents
- **THEN** the response is `200` JSON with a 5-minute public `Cache-Control`, and no Lambda function is invoked for it

#### Scenario: Content follows the deployed configuration
- **WHEN** the stack is deployed with a given MCP origin, user pool and region
- **THEN** the documents name that origin as the resource's host and the issuer, and that user pool's JWKS endpoint

### Requirement: A client can register itself for the claude.ai or claude.com callback
The registration endpoint SHALL accept an unauthenticated JSON request (RFC 7591 shape) listing `redirect_uris` and SHALL respond `201` with a `client_id` of a public client (no secret). The client SHALL be permitted the authorization code grant, PKCE, the `openid` scope, and exactly those redirect URIs. A redirect URI SHALL be allowed only if it is the claude.ai or the claude.com MCP callback (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`). Registering the same set of redirect URIs again SHALL return the same `client_id`, so that registration can create at most one client per possible set.

#### Scenario: Allowlisted registration
- **WHEN** a client registers with the claude.ai MCP callback URI
- **THEN** the response is `201` with a `client_id`, the same `redirect_uris`, and no `client_secret`

#### Scenario: Registration is idempotent
- **WHEN** the same client registers twice with the same redirect URIs
- **THEN** both responses carry the same `client_id` and only one app client exists

#### Scenario: Loopback callbacks are refused
- **WHEN** a client registers with `http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback`
- **THEN** the response is a `400` registration error (`invalid_redirect_uri`) and no client is created

#### Scenario: Other redirect URIs are refused
- **WHEN** a client registers with any other redirect URI (for example an `https` URL on another host)
- **THEN** the response is a `400` registration error (`invalid_redirect_uri`) and no client is created

#### Scenario: Registration cannot pile up clients
- **WHEN** anonymous callers send any number of registrations with any redirect URIs
- **THEN** at most three registered clients exist (one per possible set of the two allowed callbacks)

## MODIFIED Requirements

### Requirement: The unauthenticated OAuth routes are throttled
Every unauthenticated OAuth route on the MCP origin SHALL have its own throttle, stricter than the MCP stage default. These routes are the protected resource metadata, the authorization server and OpenID Connect discovery metadata, the authorize endpoint, the token endpoint and the registration endpoint. A request over its route's limit SHALL be answered `429` by API Gateway without invoking anything. The limits are:
- each of the four discovery documents: 1 request per second with a burst of 5;
- the authorize endpoint: 1 request per second with a burst of 5;
- the token endpoint: 5 requests per second with a burst of 10;
- the registration endpoint: 1 request per second with a burst of 5.

Together, the unauthenticated routes that invoke the OAuth Lambda function (authorize, token, registration) SHALL be limited to 7 requests per second.

#### Scenario: A flood on a discovery document is throttled
- **WHEN** requests to `/.well-known/oauth-protected-resource/mcp` arrive faster than 1 per second beyond a burst of 5
- **THEN** the excess requests are answered `429`, and none of the requests invokes a Lambda function

#### Scenario: A flood on the authorize endpoint is throttled
- **WHEN** requests to `GET /authorize` arrive faster than 1 per second beyond a burst of 5
- **THEN** the excess requests are answered `429` and do not invoke the OAuth Lambda function

#### Scenario: The token endpoint keeps its stricter limit
- **WHEN** requests to `POST /token` arrive faster than 5 per second beyond a burst of 10
- **THEN** the excess requests are answered `429`, even though the stage default would have allowed them

#### Scenario: The registration endpoint keeps its stricter limit
- **WHEN** requests to `POST /register` arrive faster than 1 per second beyond a burst of 5
- **THEN** the excess requests are answered `429` and no app client is created for them

## REMOVED Requirements

### Requirement: A client can register itself for allowlisted redirect URIs
**Reason**: It allowed `http` loopback callbacks on any port, so each new port created a new app client, and anonymous callers could use up the registration cap. The only clients in use are claude.ai and claude.com connectors.
**Migration**: Replaced by "A client can register itself for the claude.ai or claude.com callback". Connect local tools through the claude.ai connector, for example Claude Code signed in to the claude.ai account, instead of loopback registration.
