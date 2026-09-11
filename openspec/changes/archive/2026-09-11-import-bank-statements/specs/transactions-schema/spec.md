## Purpose

Defines the `accounts` and `transactions` tables that hold every imported bank
transaction, including the ownership column and the `dedup_key` uniqueness constraint
the ingestion pipeline relies on to avoid double-counting.

## ADDED Requirements

### Requirement: Accounts are owned rows scoped to one user
Every `accounts` row SHALL record `owner_user_id`, a bank identifier restricted to a
fixed enum (`seb`, `revolut`, `monobank`), an `iban`, a currency, and a
human-readable display name. `owner_user_id` SHALL be immutable after creation.
`iban` SHALL be unique across all accounts, since it identifies exactly one bank
account.

#### Scenario: Duplicate IBAN is rejected
- **WHEN** an insert into `accounts` uses an `iban` already present on another row
- **THEN** the database rejects the insert

#### Scenario: Account created for an upload targets a known bank
- **WHEN** a row is inserted into `accounts` with `bank = 'seb'`
- **THEN** the insert succeeds and the row's `bank` column reads `seb`

#### Scenario: Unknown bank value is rejected
- **WHEN** an insert into `accounts` sets `bank` to a value outside `seb`, `revolut`,
  `monobank`
- **THEN** the database rejects the insert

### Requirement: Transactions are owned rows linked to an account
Every `transactions` row SHALL record `owner_user_id`, a foreign key to `accounts`,
`posted_date`, `amount_minor_units`, `currency`, a normalized `description`, and a
`dedup_key`. `owner_user_id` on a transaction SHALL equal the `owner_user_id` of the
account it references.

#### Scenario: Transaction references its account's owner
- **WHEN** a transaction row is inserted referencing an account owned by user A
- **THEN** the transaction's `owner_user_id` is user A's id

### Requirement: Transactions may carry original-currency and FX-fee metadata
A `transactions` row MAY record the transaction's original (pre-conversion) currency
and amount and the conversion fee charged (amount and percent), for cases where a
bank settles a purchase in a currency other than the one it was made in. These four
columns (`original_currency`, `original_amount_minor_units`, `fx_fee_minor_units`,
`fx_fee_percent`) are nullable and exist on the schema regardless of bank; a given
parser populates them only when its source format exposes this information. Currency
and amount travel together, as do fee amount and fee percent: one is set only if the
other is too.

#### Scenario: FX metadata columns default to null
- **WHEN** a transaction row is inserted without FX metadata
- **THEN** all four FX columns are null

#### Scenario: Currency and amount are set together
- **WHEN** an insert sets `original_currency` but leaves `original_amount_minor_units`
  null (or vice versa)
- **THEN** the database rejects the insert

#### Scenario: Fee amount and fee percent are set together
- **WHEN** an insert sets `fx_fee_minor_units` but leaves `fx_fee_percent` null (or
  vice versa)
- **THEN** the database rejects the insert

### Requirement: dedup_key uniquely identifies a transaction
The `transactions` table SHALL enforce a `UNIQUE` constraint on `dedup_key`, backed by
an index, so that a second insert with the same `dedup_key` never creates a second row.

#### Scenario: Duplicate dedup_key is silently absorbed
- **WHEN** two insert attempts use the same `dedup_key`
- **THEN** only one `transactions` row exists for that `dedup_key`, and the second
  insert reports zero rows affected rather than an error that aborts the write

#### Scenario: Distinct dedup_keys both persist
- **WHEN** two insert attempts use different `dedup_key` values
- **THEN** both rows exist in `transactions`
