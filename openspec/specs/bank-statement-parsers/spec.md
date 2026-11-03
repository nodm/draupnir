# bank-statement-parsers Specification

## Purpose

Defines, per bank, how a raw CSV export is normalized into transaction rows and how
each row's `dedup_key` is computed — SEB, Revolut, and monobank do not share one
formula.

## Requirements


### Requirement: SEB parser resolves each row's own account IBAN
A SEB export file may contain rows for more than one account. The SEB parser SHALL
read each row's own account IBAN from the row itself and SHALL NOT assume every row
belongs to the account selected at upload time.

#### Scenario: A file spanning two accounts produces rows for both IBANs
- **WHEN** the SEB parser processes a file containing rows for two different account
  IBANs
- **THEN** the parsed rows carry both IBANs, each attached to the rows that belong
  to it

### Requirement: SEB parser derives dedup_key from the provider transaction ID
The SEB parser SHALL read the provider-supplied transaction identifier from each row
and SHALL compute `dedup_key` as that identifier namespaced with `seb:`, without
hashing any other field. This identifier is distinct from any shared document/batch
reference that can repeat across more than one row (e.g. both legs of a transfer
between the caller's own accounts) — only the per-row identifier may be used.

#### Scenario: Two SEB rows with the same provider id dedup
- **WHEN** the SEB parser processes two rows (from the same or different files) that
  carry the same provider transaction id
- **THEN** both rows compute the same `dedup_key`

#### Scenario: Distinct SEB provider ids never collide
- **WHEN** the SEB parser processes two rows with different provider transaction ids
- **THEN** the two rows compute different `dedup_key` values

#### Scenario: Shared document reference across two legs of a transfer does not collide
- **WHEN** the SEB parser processes two rows that share the same document reference
  but have different per-row provider transaction ids (e.g. the debit and credit
  legs of a transfer between the caller's own accounts)
- **THEN** the two rows compute different `dedup_key` values

### Requirement: Revolut and monobank parsers always use the upload-selected account
Revolut and monobank export files carry no per-row account identifier. Their parsers
SHALL attach every row to the account selected at upload time, without attempting to
read or infer an account identifier from the row itself.

#### Scenario: All rows in a Revolut or monobank file use one account
- **WHEN** the Revolut or monobank parser processes a file
- **THEN** every parsed row carries the same account IBAN — the one selected when
  the upload URL was requested

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

### Requirement: Each parser normalizes description, amount, and date before hashing
Each parser SHALL normalize a row's description (trimmed, case-folded), amount
(rounded to minor units), and posted date (resolved to a fixed timezone) before that
value is used in `dedup_key` computation or stored.

#### Scenario: Whitespace/casing differences do not change the normalized description
- **WHEN** a bank export has trailing whitespace or inconsistent casing in a
  transaction description
- **THEN** the parser's normalized `description` output has neither

### Requirement: SEB parser extracts FX metadata from foreign-currency card purchases
When a SEB card-purchase row's payment-purpose text embeds an original amount and
currency distinct from the account's settlement currency (format: `{amount}
{CCY}({eurAmount} EUR + mokestis {feeAmount} EUR({feePercent}%))`), the SEB parser
SHALL extract the original currency, original amount, FX fee amount, and FX fee
percent into the row's FX metadata fields. Rows without this pattern (domestic EUR
purchases, transfers, and all Revolut/monobank rows) SHALL leave all four fields
unset.

#### Scenario: Foreign-currency card purchase carries FX metadata
- **WHEN** the SEB parser processes a card-purchase row whose purpose text embeds a
  NOK amount and an EUR conversion with a fee
- **THEN** the parsed row's `originalCurrency` is `NOK`, `originalAmountMinorUnits`
  reflects the NOK amount, and `fxFeeMinorUnits`/`fxFeePercent` reflect the embedded
  fee

#### Scenario: Domestic and non-card rows carry no FX metadata
- **WHEN** the SEB parser processes a row whose purpose text has no embedded
  original-currency pattern (e.g. a EUR-settled transfer)
- **THEN** the parsed row's FX metadata fields are all unset

### Requirement: Each parser has a test fixture from a real anonymized sample
Each of the three parsers SHALL be validated against a test fixture derived from a
real, anonymized sample statement for that bank, covering at least: a normal row, a
row requiring description normalization, and (for SEB) a row exercising the provider-id
dedup path, or (for Revolut/monobank) a same-file repeated-transaction case exercising
`occurrence_index`.

#### Scenario: Fixture-driven test catches a dedup regression
- **WHEN** a parser's dedup-key computation changes
- **THEN** its fixture test fails if the change causes a previously-distinct pair of
  rows to collide, or a previously-equal pair to diverge

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
