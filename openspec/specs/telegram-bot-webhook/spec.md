# telegram-bot-webhook Specification

## Purpose

Receives updates from Telegram safely: only genuine Telegram requests are
accepted, Telegram is answered quickly enough not to retry, and each chat's
updates are handled in order and not twice.

## Requirements

### Requirement: Only requests carrying the webhook secret are accepted
The webhook endpoint SHALL reject any request whose
`X-Telegram-Bot-Api-Secret-Token` header does not match the configured secret,
comparing in constant time, before parsing or queuing the body.

#### Scenario: Request without the secret is rejected
- **WHEN** a request reaches the webhook endpoint with a missing or wrong secret
  header
- **THEN** it receives an error response and nothing is queued

#### Scenario: Genuine update is accepted
- **WHEN** Telegram delivers an update with the correct secret header
- **THEN** the endpoint queues it and responds with success

### Requirement: Updates are acknowledged immediately and processed asynchronously
The webhook SHALL respond to Telegram after queuing the update, without waiting
for it to be processed, so slow work (file download, database resume, AI calls)
never causes Telegram to retry delivery.

#### Scenario: Slow processing does not delay the acknowledgement
- **WHEN** processing an update would take longer than Telegram's webhook timeout
- **THEN** the webhook has already responded with success, and the update is
  processed afterwards

### Requirement: Each chat's updates are processed in order and once
Updates from the same chat SHALL be processed in the order Telegram sent them,
and an update delivered more than once by Telegram within the queue's
deduplication window SHALL be processed only once.

#### Scenario: Retried delivery is processed once
- **WHEN** Telegram delivers the same `update_id` twice within the
  deduplication window
- **THEN** the bot acts on it once and sends one reply

#### Scenario: Multi-step conversation keeps its order
- **WHEN** a user sends two answers in quick succession during a guided command
- **THEN** they are processed in the order sent

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
