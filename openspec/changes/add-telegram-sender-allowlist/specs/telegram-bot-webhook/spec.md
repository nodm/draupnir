## ADDED Requirements

### Requirement: Only allowlisted Telegram users are queued
As an access and cost guardrail, the webhook SHALL queue an update only when
its sender (the user who sent the message or pressed the button) is on the
configured allowlist of Telegram user ids. The check SHALL run after the secret
header check and update validation. An update whose sender is missing or not
on the list SHALL be acknowledged with a success response, not queued, and its
content SHALL NOT be logged. The webhook SHALL NOT access the database.

#### Scenario: Allowlisted sender is queued
- **WHEN** a message or button press from an allowlisted user arrives with the
  correct secret header
- **THEN** it is queued and the endpoint responds with success

#### Scenario: Unknown sender is dropped
- **WHEN** an update from a user who is not on the allowlist arrives with the
  correct secret header
- **THEN** the endpoint responds with success, nothing is queued and the
  update content is not logged

#### Scenario: Update without a sender is dropped
- **WHEN** an update carries no sender
- **THEN** the endpoint responds with success and nothing is queued

#### Scenario: Secret check still comes first
- **WHEN** a request with a wrong or missing secret header comes from an
  allowlisted user
- **THEN** it is rejected exactly as before and nothing is queued

#### Scenario: Linking works for allowlisted users
- **WHEN** an allowlisted user who is not linked yet sends `/start` or a
  6-digit code
- **THEN** the update is queued like any other allowlisted update

### Requirement: The allowlist fails closed
The allowlist SHALL be read from configuration once per cold start. A missing
or empty allowlist SHALL drop every update. A configured entry that is not a
numeric Telegram user id SHALL make the webhook fail at startup instead of
being ignored.

#### Scenario: Empty allowlist drops everything
- **WHEN** the allowlist is missing or empty
- **THEN** every authenticated update gets a success response and none is
  queued

#### Scenario: Malformed entry stops the webhook
- **WHEN** the configured list contains a non-numeric entry
- **THEN** the webhook fails at startup and queues nothing
