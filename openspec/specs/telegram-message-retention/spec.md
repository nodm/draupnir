# telegram-message-retention Specification

## Purpose

Limits how long financial data stays in Telegram's cloud chat history: uploaded
statements and bot messages containing account or transaction data are deleted
automatically.

## Requirements

### Requirement: Uploaded statement messages are deleted after processing
After the bot has replied with a file's outcome, it SHALL delete the user's
message that contained the file, whatever the outcome.

#### Scenario: Statement message disappears after the report
- **WHEN** a sent CSV has been processed and its outcome reported
- **THEN** the user's message containing the CSV is deleted from the chat

#### Scenario: Unprocessed file is also deleted
- **WHEN** a sent CSV was refused before ingestion (e.g. the user is not linked
  or owns no account)
- **THEN** the message containing it is deleted after the refusal reply

### Requirement: Bot messages with financial data are deleted within 48 hours
The bot SHALL record every message it sends that contains account or transaction
data (account lists, coverage, outcome reports, and later AI answers). It SHALL
delete each one no earlier than 20 hours and no later than 48 hours after it was
sent, because Telegram refuses deletion after 48 hours. This SHALL still hold when
one scheduled deletion run in a row is missed or fails. Messages without
financial data (help text, linking prompts) MAY be kept.

#### Scenario: Old account list is deleted
- **WHEN** an `/accounts` reply was sent more than 32 hours ago and every
  scheduled run since then has succeeded
- **THEN** it has been deleted from the chat

#### Scenario: Recent message is kept
- **WHEN** a recorded message was sent less than 20 hours ago
- **THEN** a deletion run leaves it in the chat

#### Scenario: One missed run still deletes in time
- **WHEN** the first scheduled run after a message turned 20 hours old fails or
  does not happen
- **THEN** the next run deletes the message, still before it is 48 hours old

#### Scenario: Failed deletion is reported, not silent
- **WHEN** a recorded message could not be deleted (e.g. the deletion run missed
  the 48-hour window)
- **THEN** the failure is logged with the chat and message id, and the record is
  not retried forever

### Requirement: The deletion schedule is configurable within the 48-hour guarantee
The operator SHALL be able to set how often the scheduled deletion run happens.
It runs every 12 hours unless configured otherwise. A deployment SHALL refuse any
setting that could let a message reach 48 hours undeleted after one missed run,
and any setting whose interval cannot be checked.

#### Scenario: Default schedule
- **WHEN** no schedule is configured
- **THEN** the deletion run happens every 12 hours

#### Scenario: Too sparse a schedule is refused
- **WHEN** the operator configures a run every 24 hours
- **THEN** the deployment fails with an error naming the setting and the longest
  allowed interval, and no infrastructure is changed

#### Scenario: Unverifiable schedule is refused
- **WHEN** the operator configures a cron or one-time expression instead of a
  fixed rate
- **THEN** the deployment fails with an error naming the setting
