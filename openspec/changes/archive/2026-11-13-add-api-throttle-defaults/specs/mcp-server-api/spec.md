## ADDED Requirements

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
