# account-management Specification

## Purpose

Lets an authenticated user create the `accounts` row a statement upload resolves
against, and lets an owner rename it — no other update, no delete. Users do this
through the Telegram bot's `/newaccount` and `/renameaccount` (see
`telegram-account-commands`).

## Requirements


### Requirement: Authenticated user can create an owned account
The system SHALL let an authenticated caller create an `accounts` row by
supplying:
- `bank`, restricted to the supported-bank list;
- `iban` and `currency`;
- a display name;
- the opening date and the opening balance.

The caller SHALL be recorded as the account's `owner` member. That identity
SHALL be taken only from the caller's authenticated identity, never from the
request payload. The account row and the membership row SHALL be created
together or not at all.

#### Scenario: Authenticated request creates an account
- **WHEN** an authenticated user requests account creation with `bank = 'seb'`,
  an IBAN, a currency, a display name, an opening date, and an opening balance
- **THEN** an `accounts` row is created with those values, and an
  `account_members` row records the caller as its `owner`

#### Scenario: Unauthenticated request is rejected
- **WHEN** a request to create an account carries no valid authenticated identity
- **THEN** the request is rejected and no `accounts` row is created

#### Scenario: Unknown bank value is rejected
- **WHEN** an authenticated user requests account creation with a `bank` value
  outside the supported-bank list
- **THEN** the request is rejected and no `accounts` row is created

#### Scenario: Duplicate IBAN is rejected
- **WHEN** an authenticated user requests account creation with an `iban`
  already used by another `accounts` row
- **THEN** the request is rejected with a reason that tells the caller to ask an
  existing owner to add them as a member, and no new `accounts` or
  `account_members` row is created

### Requirement: An upload row with no matching account fails the whole file
The statement ingestion pipeline SHALL require every row of an uploaded file to
resolve to an account that the uploader is an `owner` member of, matched by the
row's IBAN, before it writes anything from that file. If any row's IBAN has no
such account, the entire file SHALL be rejected rather than an account being
created implicitly or the resolvable rows being written.

#### Scenario: Upload with an unresolvable row IBAN fails processing
- **WHEN** a file is uploaded and at least one row's IBAN matches no account the
  uploader is an `owner` member of
- **THEN** the file is recorded as rejected with a reason naming that IBAN, no
  `raw_rows` or `transactions` rows are written for any row in that file, and no
  `accounts` row is created as a side effect

#### Scenario: A file spanning multiple existing accounts resolves each row independently
- **WHEN** a file contains rows for more than one IBAN, and the uploader is an
  `owner` member of an account for each of them
- **THEN** each row's transaction is written against its own resolved account

### Requirement: An owner can rename an account
The system SHALL let an `owner` member of an account change its display name. The new
name SHALL be non-empty after trimming and at most 60 characters. The caller's identity
SHALL come only from their authenticated identity. No other account field SHALL change.
The name is the account's, so every member sees the new name.

#### Scenario: Owner renames an account
- **WHEN** an owner renames an account to "Salary"
- **THEN** the account's display name is "Salary" and all other fields are unchanged

#### Scenario: Viewer cannot rename
- **WHEN** a `viewer` member or non-member tries to rename an account
- **THEN** the request is rejected and the display name is unchanged

#### Scenario: Invalid name is rejected
- **WHEN** an owner submits an empty, whitespace-only or over-60-character name
- **THEN** the request is rejected and the display name is unchanged
