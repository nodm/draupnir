## ADDED Requirements

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
