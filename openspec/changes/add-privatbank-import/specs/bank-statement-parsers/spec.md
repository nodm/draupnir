## ADDED Requirements

### Requirement: PrivatBank parser always uses the upload-selected account
PrivatBank export files carry only a masked card number per row, which changes when a
card is reissued and is not an account identifier. The PrivatBank parser SHALL attach
every row to the account selected at upload time and SHALL NOT read or infer an
account from the card column. The card column SHALL be kept in the raw payload.

#### Scenario: Rows from two cards of one account share the selected account
- **WHEN** the parser processes a file whose older rows name card `4149 **** **** 2167`
  and newer rows name `4149 **** **** 5889`
- **THEN** every parsed row carries the same account IBAN — the one selected at upload

### Requirement: PrivatBank parser reads the Ukrainian semicolon export
The parser SHALL accept the export's layout: a title line stating the period
(`Історія операцій за період DD.MM.YYYY - DD.MM.YYYY`), then the header, then data rows,
all `;`-delimited, with `,` as the decimal separator, CRLF line ends, and rows newest
first. The title line SHALL NOT produce a row. The row's timestamp is
`DD.MM.YYYY HH:MM:SS`.

#### Scenario: Title line is skipped, rows are numbered from the first data row
- **WHEN** the parser processes a file with a title line, a header and 3 data rows
- **THEN** it yields 3 rows numbered 1–3, none derived from the title

#### Scenario: Decimal comma is read
- **WHEN** a row's card amount is `-2610,93`
- **THEN** its normalized amount is −261093 minor units

### Requirement: PrivatBank amounts are in the card currency
The parser SHALL take the normalized amount (signed), currency and balance from the
card-currency columns (`Сума в валюті картки`, `Валюта картки`,
`Залишок на кінець періоду`), so the per-row balance chain stays in the account
currency. When the transaction currency (`Валюта транзакції`) differs from the card
currency, the transaction amount (magnitude) SHALL be kept as the original amount with
its sign following the card amount, and its currency as the original currency.

#### Scenario: Foreign-currency operation keeps the original amount
- **WHEN** a UAH-card row has card amount `-4404,91`, transaction amount `395,12`
  and transaction currency `PLN`
- **THEN** the normalized row is −440491 in `UAH` with original amount −39512 in `PLN`

#### Scenario: Same-currency operation has no original amount
- **WHEN** card and transaction currency are both `UAH`
- **THEN** the normalized row has no original currency or amount

### Requirement: PrivatBank parser derives dedup_key by hash fallback
The PrivatBank export has no bank transaction id. The parser SHALL compute `dedup_key`
as the deterministic hash of `iban + posted_date + amount_minor_units + currency +
normalized_description + time_of_day + occurrence_index`, where `time_of_day` is the
row's `HH:MM:SS`. `occurrence_index` ranks rows of the file that share all other values.
Other banks' keys SHALL NOT change.

#### Scenario: Identical same-day rows at different times differ by time
- **WHEN** a file has two rows with identical account, date, amount, currency and
  description but different times
- **THEN** they get distinct `dedup_key` values, each with `occurrence_index` 0

#### Scenario: Identical same-second rows stay distinct
- **WHEN** a file has two rows identical including the timestamp
- **THEN** they get `occurrence_index` 0 and 1 and distinct `dedup_key` values

#### Scenario: Re-parsing produces the same keys
- **WHEN** the same file is parsed twice
- **THEN** each row computes the same `dedup_key` both times

### Requirement: PrivatBank rows are ordered newest first with the balance as tiebreak
Transaction order SHALL be the row timestamp, then reversed file order for equal
timestamps (the file lists newest first, so the later row in the file happened first).
Every data row enters `transactions`.

#### Scenario: Same-second rows chain by file order
- **WHEN** two rows share one timestamp, the first in the file with balance 422,11
  after amount −811,11 and the second with balance 1233,22 after amount −2484,48
- **THEN** the second-listed row is ordered before the first-listed and the balance
  chain holds

### Requirement: PrivatBank rows carry balance-after but no fee
The parser SHALL extract each row's balance (`Залишок на кінець періоду`) into
`balanceAfterMinorUnits` in the card currency and SHALL report fee as 0.

#### Scenario: Balance extracted
- **WHEN** a EUR row has balance `3837,17`
- **THEN** its `balanceAfterMinorUnits` is 383717

### Requirement: PrivatBank parser has a test fixture from a real anonymized sample
The parser SHALL be validated against anonymized fixtures derived from the real UAH and
EUR samples, covering at least: a card reissue (two card masks in one file), a
foreign-currency row, two rows with the same timestamp, a refund (positive amount with
the same description as a purchase), a transfer between own cards, and an empty
category cell.

#### Scenario: Fixture-driven test catches a dedup or order regression
- **WHEN** the dedup-key or ordering computation changes
- **THEN** the fixture test fails if previously-distinct rows collide or the balance
  chain over the same-timestamp rows breaks
