# mcp-server-api Specification

## Purpose

Provides the deployed, Cognito-authenticated base API the `mcp` server runs
behind — the API Gateway REST API, its Lambda integration, and a minimal
Streamable HTTP endpoint that proves the authorizer wiring works — ahead of any
MCP tools/resources being implemented on top of it.

## Requirements

### Requirement: MCP API requires the same Cognito authorizer as ingestion
The `mcp` REST API SHALL attach a `COGNITO_USER_POOLS` authorizer backed by the
same Cognito user pool `ingestion` uses. A request without a valid Cognito JWT
SHALL be rejected before reaching the Lambda handler.

#### Scenario: Request with a valid token issued by the shared pool is authorized
- **WHEN** a request to the MCP endpoint carries a valid Cognito JWT issued by the
  shared user pool
- **THEN** API Gateway forwards the request to the Lambda handler with the
  token's claims injected

#### Scenario: Request with no token is rejected
- **WHEN** a request to the MCP endpoint carries no Authorization header
- **THEN** the request is rejected by the authorizer and the Lambda handler is
  never invoked

#### Scenario: Request with an invalid or expired token is rejected
- **WHEN** a request to the MCP endpoint carries a malformed, expired, or
  wrong-pool JWT
- **THEN** the request is rejected by the authorizer and the Lambda handler is
  never invoked

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
