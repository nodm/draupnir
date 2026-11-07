## MODIFIED Requirements

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
