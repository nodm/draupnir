## Purpose

Lets an authenticated user create the `accounts` row a statement upload resolves
against — a minimal create-only endpoint, no update/delete/list in this change.

## ADDED Requirements

### Requirement: Authenticated user can create an owned account
The system SHALL let an authenticated caller create an `accounts` row by supplying
`bank` (restricted to `seb`, `revolut`, `monobank`), `iban`, `currency`, and a display
name. `owner_user_id` on the created row SHALL be taken only from the caller's
Cognito claim, never from the request payload.

#### Scenario: Authenticated request creates an account
- **WHEN** an authenticated user requests account creation with `bank = 'seb'`, an
  IBAN, a currency, and a display name
- **THEN** an `accounts` row is created with `owner_user_id` equal to that user's sub,
  `bank` equal to `seb`, and the supplied `iban`

#### Scenario: Unauthenticated request is rejected
- **WHEN** a request to create an account carries no valid Cognito token
- **THEN** the request is rejected and no `accounts` row is created

#### Scenario: Unknown bank value is rejected
- **WHEN** an authenticated user requests account creation with a `bank` value outside
  `seb`, `revolut`, `monobank`
- **THEN** the request is rejected and no `accounts` row is created

#### Scenario: Duplicate IBAN is rejected
- **WHEN** an authenticated user requests account creation with an `iban` already
  used by another `accounts` row
- **THEN** the request is rejected and no new `accounts` row is created

### Requirement: An upload row with no matching account fails the whole file
The statement ingestion pipeline SHALL require a matching `accounts` row (same owner,
same IBAN as the row) to exist for every row before it writes any transaction from an
uploaded file. If any row's IBAN has no matching account, processing of the entire
file SHALL fail rather than create an account implicitly or write the rows that do
resolve.

#### Scenario: Upload with an unresolvable row IBAN fails processing
- **WHEN** a file is uploaded and at least one row's IBAN has no matching `accounts`
  row owned by the uploading user
- **THEN** the file's processing fails, no `transactions` rows are written for any
  row in that file, and no `accounts` row is created as a side effect

#### Scenario: A file spanning multiple existing accounts resolves each row independently
- **WHEN** a file contains rows for more than one IBAN, and an `accounts` row already
  exists for each of them owned by the uploading user
- **THEN** each row's transaction is written against its own resolved account
