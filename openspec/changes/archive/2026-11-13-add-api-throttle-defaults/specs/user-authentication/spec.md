## ADDED Requirements

### Requirement: Every ingestion API method has a default throttle
The `ingestion` REST API stage SHALL apply a default throttle of 5 requests per
second with a burst of 10 to every method, sized for its two users. The limit
SHALL apply to each method separately. A request over the limit SHALL be answered
`429` by API Gateway before the Cognito authorizer or any handler runs.

#### Scenario: Normal use stays under the limit
- **WHEN** a signed-in user calls `whoami`, creates an account and requests a few
  upload URLs in a row
- **THEN** no request is throttled

#### Scenario: A flood is throttled before authorization
- **WHEN** requests to an ingestion route, with or without a token, arrive faster
  than 5 per second beyond a burst of 10
- **THEN** the excess requests are answered `429` and no handler runs for them
