## Purpose

Defines one set of read-only data tools (name, input, output, and scoping),
shared by every AI surface (the Telegram AI chat and the MCP server), so both
see exactly the same data, scoped to the calling user.

## ADDED Requirements

### Requirement: Tools are read-only and scoped to the caller
Every data tool SHALL run with the calling user's identity (see
`row-level-authorization`), SHALL return only data from accounts the caller is
a member of, and SHALL NOT modify any data. A tool invoked without a resolved
caller identity SHALL return an error and SHALL NOT query the database.

#### Scenario: Tool returns only the caller's visible data
- **WHEN** user B, a viewer of account A1 only, calls `list_transactions` with no
  filters
- **THEN** only account A1's transactions are returned

#### Scenario: Missing identity is refused before querying
- **WHEN** a tool is invoked without a resolved caller identity
- **THEN** it returns an error and no database query is made

### Requirement: list_accounts returns the caller's accounts
`list_accounts` SHALL take no input and return every account the caller is a
member of, each with:
- id, display name, bank, currency;
- the IBAN masked to its last 4 characters;
- the caller's role;
- the "reconciled up to" date.

#### Scenario: Accounts with roles
- **WHEN** a user who owns one account and views another calls `list_accounts`
- **THEN** both are returned with roles `owner` and `viewer`

### Requirement: list_transactions filters and paginates
`list_transactions` SHALL accept these optional inputs:
- `accountId`;
- `from` and `to` (inclusive posted dates);
- `text` (case-insensitive substring of the description);
- `limit` (default 50, maximum 200);
- `cursor`.

It SHALL return transactions newest first (posted date, then id), each with
account id, posted date, amount and currency, fee, balance-after, and
description. It SHALL also return a `nextCursor` only when more rows exist.

The tool SHALL reject an out-of-range `limit` or a malformed cursor with an
error. An `accountId` the caller can't see SHALL yield an empty list, not an
error.

#### Scenario: Pagination round-trips without gaps or duplicates
- **WHEN** a caller pages through 120 matching transactions with `limit` 50
- **THEN** three pages of 50, 50, and 20 are returned, the last without a
  `nextCursor`, and together they contain each transaction exactly once

#### Scenario: Exactly full last page has no cursor
- **WHEN** exactly 50 transactions match and `limit` is 50
- **THEN** one page is returned with no `nextCursor`

#### Scenario: Invisible account yields an empty list
- **WHEN** a caller passes an `accountId` they are not a member of
- **THEN** the result is an empty list

#### Scenario: Limit above maximum is rejected
- **WHEN** a caller passes `limit` 500
- **THEN** the tool returns an error naming the maximum

### Requirement: summarize_transactions aggregates without mixing currencies
`summarize_transactions` SHALL accept:
- `from` and `to` (required);
- optional `accountId`;
- optional `text` filter;
- `groupBy` (`month` | `account` | `description`).

It SHALL return, per group and per currency:
- the sum of incoming amounts;
- the sum of outgoing amounts;
- the sum of fees;
- the transaction count.

Amounts in different currencies SHALL never be added together.

#### Scenario: Monthly totals per currency
- **WHEN** a caller summarizes January–March grouped by month across EUR and UAH
  accounts
- **THEN** each month has separate EUR and UAH totals, and no total combines
  the two currencies

### Requirement: get_account_coverage reports covered periods
`get_account_coverage` SHALL take an `accountId` and return its covered periods,
gaps, and "reconciled up to" date (see `statement-validation`), or an empty
result for an account the caller can't see.

#### Scenario: Coverage of a visible account
- **WHEN** a member asks for coverage of an account with January and March
  imported
- **THEN** both periods and the February gap are returned

### Requirement: Bank-provided text is marked as untrusted
Every tool output that contains text originating from a bank file
(descriptions, counterparty names) SHALL deliver that text in fields explicitly
marked as untrusted, external data, separate from fields produced by the system.

#### Scenario: Description is delivered as untrusted data
- **WHEN** `list_transactions` returns a transaction whose description contains
  the text "ignore previous instructions"
- **THEN** that text appears only inside the field marked as untrusted bank
  data
