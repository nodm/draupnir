## ADDED Requirements

### Requirement: Parsers emit the raw payload and format version with each row
Each parser SHALL output, for every data row of a file:
- the raw payload: a map of each original column header to the cell's
  original string value;
- the 1-based row number;
- the detected format version;
- the bank's own transaction identifier, when the format has one;
- the normalized row, when the row is one that enters `transactions`.

#### Scenario: Raw payload accompanies the normalized row
- **WHEN** a parser processes a valid row
- **THEN** its output contains both the untouched original cell strings keyed by
  header and the normalized transaction fields

### Requirement: Parsers extract fee and balance-after when the format has them
The Revolut and monobank parsers SHALL extract each row's fee (Revolut `Fee`,
monobank commission) and per-row balance (`Balance`) into minor units on the
normalized row. The SEB parser SHALL report fee as 0 and balance-after as
absent, since its current export format has no per-row balance.

The monobank parser SHALL express the normalized amount, fee, and balance in
the card (account) currency, which its card-currency column headers state, so
that the per-row balance chain stays in the account currency. When a row's
operation currency differs from the card currency, the operation amount and
currency SHALL be kept as the transaction's original amount and currency.

#### Scenario: Revolut balance and fee are extracted
- **WHEN** the Revolut parser processes a row with `Fee` `0.00` and `Balance`
  `11.33` in EUR
- **THEN** the normalized row has `feeMinorUnits` 0 and
  `balanceAfterMinorUnits` 1133

#### Scenario: monobank foreign-currency operation keeps the original amount
- **WHEN** the monobank parser processes a row on a UAH card with card-currency
  amount `-41.2`, operation amount `-1.0`, and operation currency `USD`
- **THEN** the normalized row has amount -4120 in `UAH`, and original amount
  -100 in `USD`

### Requirement: Revolut rows enter transactions only when completed
The Revolut parser SHALL produce a normalized row only for rows whose `State`
is `COMPLETED` and whose `Product` is `Current`. Every other row — any other
state (`PENDING`, `REVERTED`, `DECLINED`, …), or a completed row of another
product (for example a savings vault) — SHALL be output with its raw payload
only.

#### Scenario: Pending row stays raw-only
- **WHEN** the Revolut parser processes a row with `State` `PENDING`
- **THEN** the row's raw payload is output and no normalized row is produced
  for it

#### Scenario: Completed non-Current row stays raw-only
- **WHEN** the Revolut parser processes a `COMPLETED` row whose `Product` is
  `Savings`
- **THEN** the row's raw payload is output and no normalized row is produced
  for it

## MODIFIED Requirements

### Requirement: Revolut and monobank parsers use a hash-fallback dedup_key
The Revolut and monobank parsers SHALL compute `dedup_key` as a deterministic
hash of `iban + posted_date + amount_minor_units + currency +
normalized_description + occurrence_index`. Here `iban` is the row's account
IBAN, and `occurrence_index` is the row's rank (0-based) among rows in the same
source file that share identical values for the other fields. For Revolut,
`posted_date` used in the hash SHALL be derived from `Started Date`, which does
not change when a pending transaction later completes. Revolut's stored
`posted_date` SHALL use the same value.

#### Scenario: Two genuinely distinct same-day identical-looking purchases both persist
- **WHEN** a single file contains two rows with identical account, date, amount,
  currency, and description
- **THEN** the parser assigns them `occurrence_index` 0 and 1 respectively,
  producing two distinct `dedup_key` values, and both rows are written

#### Scenario: Re-parsing the same file produces the same keys
- **WHEN** the same Revolut or monobank file is parsed twice
- **THEN** each row computes the same `dedup_key` both times

#### Scenario: A Revolut transaction keeps its key after completing
- **WHEN** a transaction appears as `COMPLETED` in a later export with a
  different `Completed Date` but the same `Started Date`, amount, and description
- **THEN** it computes the same `dedup_key` it would have had if it had been
  completed in the earlier export
