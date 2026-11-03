## Purpose

Limits how long financial data stays in Telegram's cloud chat history: uploaded
statements and bot messages containing account or transaction data are deleted
automatically.

## ADDED Requirements

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

### Requirement: Bot messages with financial data are deleted after 24 hours
The bot SHALL record every message it sends that contains account or transaction
data (account lists, coverage, outcome reports, and later AI answers), and SHALL
delete each one between 24 and 48 hours after it was sent (Telegram refuses
deletion after 48 hours). Messages without financial data (help text, linking
prompts) MAY be kept.

#### Scenario: Old account list is deleted
- **WHEN** an `/accounts` reply was sent more than 24 hours ago
- **THEN** it has been deleted from the chat

#### Scenario: Failed deletion is reported, not silent
- **WHEN** a recorded message could not be deleted (e.g. the deletion run missed
  the 48-hour window)
- **THEN** the failure is logged with the chat and message id, and the record is
  not retried forever
