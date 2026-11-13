# cost-guardrails Specification

## Purpose

Keeps a backlog in one of the queues from using up the account's Lambda capacity, and records the account-level concurrency ceiling that bounds the rest, so that spend has an upper limit that does not depend on callers behaving.

## Requirements

### Requirement: Queue-driven functions are capped at the event source mapping
Each SQS event source mapping SHALL set a maximum concurrency of 2: the `ingest` mapping, the `bot-worker` mapping on the Telegram updates queue and the `bot-worker` mapping on the statement outcomes queue. The cap is per mapping, so the Telegram bot's worker MAY run up to 4 invocations at once. Queue-driven functions SHALL NOT use reserved concurrency for this purpose, so that a message is never received and then throttled.

#### Scenario: A backlog is drained at the cap
- **WHEN** a backlog builds on a capped queue
- **THEN** at most 2 invocations per mapping run at once, the rest of the backlog stays in the queue, and no message is moved to the dead-letter queue because of the cap

#### Scenario: Telegram updates of one chat stay in order
- **WHEN** several updates of one chat are queued while the cap is in effect
- **THEN** they are still handled one at a time in the order they were sent, and updates of other chats can run in parallel up to the cap

#### Scenario: Queue consumers leave capacity for other functions
- **WHEN** every capped mapping is running at its cap
- **THEN** the queue consumers use at most 6 concurrent executions, so that with the account's quota of 10, at least 4 remain for the API functions and the Cognito pre-sign-up trigger

### Requirement: The account concurrency ceiling is recorded
The documentation SHALL state the account's Lambda concurrent-executions quota, the date it was read, and that it is an AWS setting that this repository does not control. It SHALL also state that if the quota changes, the queue cap and the unused option of per-function reservations (which need the quota to exceed their sum by 10) are to be revisited.

#### Scenario: Documentation names the quota
- **WHEN** a maintainer reads the architecture documentation
- **THEN** it gives the quota (10), the date it was read (2026-11-13) and the instruction to re-check it with `aws lambda get-account-settings` before relying on it
