# mcp-server-api Specification

## Purpose

Provides the deployed, Cognito-authenticated base API the `mcp` server runs
behind — the API Gateway REST API, its Lambda integration, and a minimal
Streamable HTTP endpoint that proves the authorizer wiring works — ahead of any
MCP tools/resources being implemented on top of it.

## Requirements

### Requirement: MCP API requires the same Cognito authorizer as ingestion
The `mcp` REST API SHALL attach a `COGNITO_USER_POOLS` authorizer backed by the
same Cognito user pool `ingestion` uses, and SHALL accept an OAuth **access
token** issued by that pool (the token MCP clients send). A request without a
valid access token SHALL be rejected before reaching the Lambda handler with a
`401` carrying the discovery challenge defined by `mcp-oauth-discovery`.

#### Scenario: Request with a valid token issued by the shared pool is authorized
- **WHEN** a request to the MCP endpoint carries a valid access token issued by the
  shared user pool
- **THEN** API Gateway forwards the request to the Lambda handler with the
  token's claims injected

#### Scenario: Request with no token is rejected
- **WHEN** a request to the MCP endpoint carries no Authorization header
- **THEN** the request is rejected by the authorizer with a `401` discovery
  challenge and the Lambda handler is never invoked

#### Scenario: Request with an invalid or expired token is rejected
- **WHEN** a request to the MCP endpoint carries a malformed, expired, or
  wrong-pool token
- **THEN** the request is rejected by the authorizer and the Lambda handler is
  never invoked

#### Scenario: An ID token is not accepted
- **WHEN** a request to the MCP endpoint carries an ID token instead of an access
  token
- **THEN** the request is rejected by the authorizer

### Requirement: MCP endpoint identifies the caller only from the authorizer claim
The Lambda handler SHALL resolve the calling user's identity only from the
authorizer-injected `sub` claim, never from the request body or any other
caller-supplied field, matching ADR-0001's per-request scoping requirement.

#### Scenario: Response reflects the authenticated caller's sub
- **WHEN** an authenticated request reaches the handler
- **THEN** the handler's response is derived from that request's injected `sub`
  claim, not from any identifier present in the request body

#### Scenario: A body-supplied identifier is ignored
- **WHEN** an authenticated request's body includes a user or account identifier
  field
- **THEN** the handler's behavior is unaffected by that field's value

### Requirement: MCP endpoint speaks the Streamable HTTP transport shape
The endpoint SHALL accept `POST` requests carrying a JSON-RPC request body per
the MCP Streamable HTTP transport (spec revision 2026-07-28) and SHALL respond
with a single JSON-RPC response object for this minimal endpoint (no SSE
stream, no session id, per the stateless 2026-07-28 revision).

#### Scenario: Valid JSON-RPC request receives a JSON-RPC response
- **WHEN** an authenticated `POST` carries a well-formed JSON-RPC request object
- **THEN** the response body is a single JSON-RPC response object correlated to
  that request's id

#### Scenario: Malformed JSON-RPC body is rejected
- **WHEN** an authenticated `POST`'s body is not a well-formed JSON-RPC request
- **THEN** the handler returns an error response rather than crashing or
  returning a 5xx with no body

### Requirement: The MCP API is reachable only on its custom domain
The `mcp` REST API SHALL be served only on its custom domain. Its default
`execute-api` endpoint SHALL be disabled, so that every route (the MCP endpoint
and the OAuth routes) has one public address, and the stack SHALL NOT export the
`execute-api` URL of the MCP API.

#### Scenario: Request through the custom domain
- **WHEN** a client sends a request to `https://<mcp host>/mcp` or to an OAuth
  route on that host
- **THEN** it is handled as before

#### Scenario: Request through the default endpoint
- **WHEN** a client sends any request to the MCP API's
  `https://<api id>.execute-api.<region>.amazonaws.com/<stage>/...` URL
- **THEN** API Gateway answers `403` and no Lambda function is invoked

#### Scenario: Stack outputs name only the custom domain
- **WHEN** a maintainer lists the stack outputs
- **THEN** `mcpUrl` gives the MCP endpoint on the custom domain and there is no
  output with the MCP API's `execute-api` URL

### Requirement: Every MCP API method has a default throttle
The `mcp` REST API stage SHALL apply a default throttle of 10 requests per second
with a burst of 20 to every method that has no stricter limit of its own. The
limit SHALL apply to each method separately. A request over the limit SHALL be
answered `429` by API Gateway without invoking a Lambda function or the
authorizer.

#### Scenario: Normal client use stays under the limit
- **WHEN** an MCP client connects (discovery, registration, sign-in, token, then
  `initialize`, `notifications/initialized` and `tools/list`) and then calls tools
- **THEN** no request is throttled

#### Scenario: A flood on the MCP endpoint is throttled
- **WHEN** requests to `POST /mcp` arrive faster than the burst and rate allow
- **THEN** the excess requests are answered `429` and do not invoke the `mcp`
  Lambda function
