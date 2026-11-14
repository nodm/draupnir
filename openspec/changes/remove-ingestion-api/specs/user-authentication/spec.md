## ADDED Requirements

### Requirement: Only the MCP API accepts the user pool's bearer tokens
The MCP API SHALL be the only API of the stack that accepts a bearer token issued by the user pool. It accepts access tokens only. Any other route that receives a user pool token SHALL verify that the token was issued to that route's own app client. For example, the Telegram sign-in callback checks the audience of the ID token it gets from its own code exchange. As a result, a token issued to a client that an MCP client registered SHALL grant no access beyond the MCP tools.

#### Scenario: No other API has a user pool authorizer
- **WHEN** the stack is built
- **THEN** exactly one REST API has a Cognito user pool authorizer, and it is the MCP API

#### Scenario: A registered MCP client's ID token opens nothing
- **WHEN** an ID token issued to a client registered through the MCP registration endpoint is sent to any route of the stack
- **THEN** the route refuses it: the MCP endpoint refuses ID tokens, and no other route accepts tokens issued to that client

## REMOVED Requirements

### Requirement: Authenticated identity is retrievable via a whoami endpoint
**Reason**: The `whoami` route belonged to the ingestion REST API, which is removed. It was built for a browser client that ADR-0009 replaced with the Telegram bot.
**Migration**: None needed, because no client calls it. The MCP server's `whoami` tool still returns the caller's identity to MCP clients.

### Requirement: Every ingestion API method has a default throttle
**Reason**: The ingestion REST API, and with it its stage and throttle, is removed.
**Migration**: None. The remaining REST APIs (`draupnir-mcp`, `draupnir-bot`) keep their own throttles.
