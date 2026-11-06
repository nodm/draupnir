# telegram-statement-upload Specification

## Purpose

Lets a linked user import a bank statement by sending the CSV file to the bot,
and tells them in the chat whether it was approved, rejected (and why), or
approved with coverage warnings.

## Requirements

### Requirement: A sent statement is attached to an account the user owns
When a linked user sends a document, the bot SHALL accept it only if:
- it is a CSV;
- it is within Telegram's bot download limit;
- the user is an `owner` member of at least one account.

The bot SHALL then choose the account:
- an SEB file whose header IBAN matches exactly one account the user owns is
  attached to that account automatically;
- otherwise the bot SHALL ask with buttons listing the accounts the user owns.

A pending choice SHALL expire after 1 hour.

#### Scenario: Account chosen from buttons
- **WHEN** a user who owns two accounts sends a Revolut CSV and taps one of the
  offered accounts
- **THEN** the file is handed to ingestion for that account

#### Scenario: SEB file auto-selects its account
- **WHEN** a user sends an SEB CSV whose header IBAN matches one account they own
- **THEN** the file is handed to ingestion for that account without asking

#### Scenario: Viewer-only user cannot upload
- **WHEN** a user who is only a `viewer` of every account they belong to sends a
  CSV
- **THEN** the file is not processed and the bot explains that an owner must
  import it or create their own account first

#### Scenario: Non-CSV document is refused
- **WHEN** a user sends a PDF
- **THEN** it is not processed and the bot says only CSV exports are supported

### Requirement: Bot uploads use the same ingestion path as every other upload
The bot SHALL store an accepted file in the statement upload bucket at
`uploads/{sub}/{accountId}/{uuid}.csv`, where `sub` is the linked identity and
`accountId` is the chosen account. From there the file SHALL go through the
standard ingestion pipeline and validation, unchanged.

#### Scenario: Bot upload lands under the linked user's prefix
- **WHEN** a linked user's file is accepted for account X
- **THEN** an object exists at `uploads/{that user's sub}/X/{uuid}.csv` and the
  ingestion pipeline processes it

### Requirement: The outcome is reported in the chat
For each file handed to ingestion, the bot SHALL reply in the same chat with
the outcome:
- `approved`: with the number of new transactions, the covered period, and any
  coverage warnings;
- `rejected`: with every rejection reason, including row numbers where given.

#### Scenario: Approved file report
- **WHEN** a file is approved with a gap warning
- **THEN** the bot replies with the count of new transactions, the period
  covered, and the gap

#### Scenario: Outcome delivered twice is reported once
- **WHEN** the same file's outcome is delivered to the bot twice
- **THEN** the chat receives one report

#### Scenario: Concurrent duplicate deliveries are reported once
- **WHEN** the same file's outcome is delivered to two bot workers at the same
  time
- **THEN** exactly one of them sends the report

#### Scenario: Crash before reporting is recovered
- **WHEN** a worker takes responsibility for a report and stops before sending it
- **THEN** the report is sent by a later delivery after a short delay

#### Scenario: Rejected file report
- **WHEN** a file is rejected for a broken balance chain at row 37
- **THEN** the bot replies that the file was rejected and includes the row 37
  reason with expected and actual balances
