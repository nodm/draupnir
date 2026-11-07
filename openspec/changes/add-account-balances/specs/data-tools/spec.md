## MODIFIED Requirements

### Requirement: list_accounts returns the caller's accounts
`list_accounts` SHALL take no input and return every account the caller is a
member of, each with:
- id, display name, bank, currency;
- the IBAN masked to its last 4 characters;
- the caller's role;
- the "reconciled up to" date;
- the account's current balance in minor units, the date it is as of, and whether
  it is reconciled.

The tool's description SHALL tell the caller to state the as-of date whenever it
quotes a balance, and to say that the balance is not reconciled when the flag is
false.

#### Scenario: Accounts with roles
- **WHEN** a user who owns one account and views another calls `list_accounts`
- **THEN** both are returned with roles `owner` and `viewer`

#### Scenario: Balance is returned with its date
- **WHEN** a member calls `list_accounts` for an account whose latest imported
  transaction is dated 2026-10-30
- **THEN** the account carries its stored balance, as of 2026-10-30, and its
  reconciled flag

#### Scenario: Viewer sees the balance
- **WHEN** a viewer calls `list_accounts` for a shared account
- **THEN** the same balance, date and flag are returned as for the owner

### Requirement: list_transactions filters and paginates
`list_transactions` SHALL accept these optional inputs:
- `accountId`;
- `from` and `to` (inclusive posted dates);
- `text` (case-insensitive substring of the description);
- `limit` (default 50, maximum 200);
- `cursor`.

It SHALL return transactions newest first in the account's transaction order
(see `account-balances`), each with account id, posted date, amount and
currency, fee, running balance, and description. It SHALL also return a
`nextCursor` only when more rows exist.

The tool SHALL reject an out-of-range `limit` or a malformed cursor with an
error; a cursor issued before the order changed is malformed. An `accountId` the
caller can't see SHALL yield an empty list, not an error.

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

#### Scenario: Running balance is returned on every row
- **WHEN** a caller lists transactions of an SEB account
- **THEN** each transaction carries its running balance, even though the bank
  reports none

#### Scenario: Same-day rows are in balance-change order
- **WHEN** several transactions share a posted date
- **THEN** they are returned newest first in the order the balance changed, and
  each row's running balance equals the next-older row's running balance plus
  its own amount minus its fee
