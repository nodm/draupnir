## MODIFIED Requirements

### Requirement: Accounts are owned rows scoped to one user
Every `accounts` row SHALL record:
- a bank identifier restricted to the supported-bank list (`seb`, `revolut`,
  `monobank` at the time of writing; adding a bank is a migration plus a
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

#### Scenario: Unknown bank value is rejected
- **WHEN** an insert into `accounts` sets `bank` to a value outside the
  supported-bank list
- **THEN** the database rejects the insert

#### Scenario: Opening balance is recorded
- **WHEN** an account is created with `opened_on = 2024-01-15` and an opening
  balance of 0
- **THEN** the row's `opened_on` and `opening_balance_minor_units` read those
  values

### Requirement: Transactions are owned rows linked to an account
Every `transactions` row SHALL record:
- a foreign key to `accounts`;
- `posted_date`, `amount_minor_units`, and `currency`;
- a normalized `description`;
- `fee_minor_units` (0 when the bank reports no fee);
- `balance_after_minor_units` (null when the bank's format has no per-row
  balance);
- a `dedup_key`.

A transaction's visibility SHALL derive from its account's membership; the row
SHALL NOT carry its own owner column. Every transaction SHALL be linked through
`transaction_sources` to at least one raw row it was derived from.

#### Scenario: Transaction references its account's owner
- **WHEN** a transaction row is inserted referencing an existing account
- **THEN** the insert succeeds and the transaction is visible to exactly the
  users who are members of that account

#### Scenario: Transaction from two overlapping files has two sources
- **WHEN** the same transaction appears in two approved files for one account
- **THEN** one `transactions` row exists for it, linked to two raw rows

#### Scenario: Balance-after is null for formats without balances
- **WHEN** a transaction is derived from a SEB row (no per-row balance in the
  format)
- **THEN** its `balance_after_minor_units` is null

### Requirement: dedup_key uniquely identifies a transaction
The `transactions` table SHALL enforce uniqueness of `dedup_key` within an
account (`UNIQUE (account_id, dedup_key)`), backed by an index, so a second
derivation of the same transaction for the same account never creates a second
row, and identical keys on different accounts never interfere with each other.

#### Scenario: Duplicate dedup_key is silently absorbed
- **WHEN** two derivations for the same account produce the same `dedup_key`
- **THEN** only one `transactions` row exists for that account and key, and the
  second derivation adds a source link instead of failing the write

#### Scenario: Same dedup_key on different accounts both persist
- **WHEN** derivations for two different accounts produce the same `dedup_key`
- **THEN** each account has its own `transactions` row with that key

#### Scenario: Distinct dedup_keys both persist
- **WHEN** two derivations for one account produce different `dedup_key` values
- **THEN** both rows exist in `transactions`
