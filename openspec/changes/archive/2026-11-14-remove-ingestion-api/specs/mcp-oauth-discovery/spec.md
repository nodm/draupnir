## MODIFIED Requirements

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
  response is returned without its `id_token` (a token MCP clients do not need,
  and that no API of the stack accepts from them), and only the authorization code
  and refresh token grants are forwarded
