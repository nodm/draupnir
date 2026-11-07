## Purpose

Receives updates from Telegram safely: only genuine Telegram requests are
accepted, Telegram is answered quickly enough not to retry, and each chat's
updates are handled in order and not twice.

## ADDED Requirements

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
