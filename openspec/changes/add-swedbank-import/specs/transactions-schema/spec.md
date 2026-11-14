## MODIFIED Requirements

### Requirement: Accounts are owned rows scoped to one user
Every `accounts` row SHALL record:
- a bank identifier restricted to the supported-bank list (`seb`, `revolut`,
  `monobank`, `swedbank` at the time of writing; adding a bank is a migration plus a
  parser);
- an `iban` and a currency;
- a human-readable display name;
- the date the account was opened (`opened_on`);
- the opening balance in minor units (`opening_balance_minor_units`).

`iban` SHALL be unique across all accounts, since it identifies exactly one
bank account; users share an account through membership (see
`row-level-authorization`), never by creating a second account row for the
same IBAN. `accounts` SHALL NOT carry an owner column.

#### Scenario: Duplicate IBAN is rejected
- **WHEN** an insert into `accounts` uses an `iban` already present on another row
- **THEN** the database rejects the insert

#### Scenario: Account created for an upload targets a known bank
- **WHEN** a row is inserted into `accounts` with `bank = 'seb'`
- **THEN** the insert succeeds and the row's `bank` column reads `seb`

#### Scenario: Swedbank account is accepted
- **WHEN** a row is inserted into `accounts` with `bank = 'swedbank'`
- **THEN** the insert succeeds and the row's `bank` column reads `swedbank`

#### Scenario: Existing accounts survive the new bank
- **WHEN** the migration adding `swedbank` is applied to a database holding
  `seb`, `revolut` and `monobank` accounts
- **THEN** all existing accounts and their transactions are unchanged

#### Scenario: Unknown bank value is rejected
- **WHEN** an insert into `accounts` sets `bank` to a value outside the
  supported-bank list
- **THEN** the database rejects the insert

#### Scenario: Opening balance is recorded
- **WHEN** an account is created with `opened_on = 2024-01-15` and an opening
  balance of 0
- **THEN** the row's `opened_on` and `opening_balance_minor_units` read those
  values
