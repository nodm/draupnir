## ADDED Requirements

### Requirement: PrivatBank format is detected and checked
The system SHALL recognise the PrivatBank export by its title line (one cell, matching
`Історія операцій за період DD.MM.YYYY - DD.MM.YYYY`, remaining cells empty) followed
by the 10 Ukrainian header names in order, as format version `privatbank-v1`. Every
row SHALL be checked: a real `DD.MM.YYYY HH:MM:SS` timestamp, a card cell, a signed
decimal card amount and a positive decimal transaction amount (`,` separator), three-letter
currency codes, and a decimal balance. The category cell MAY be empty.

#### Scenario: Real export header is recognised
- **WHEN** a PrivatBank account's upload has the title line and header of the samples
- **THEN** the format is detected as `privatbank-v1`

#### Scenario: Missing title line is rejected
- **WHEN** a PrivatBank account's upload starts directly with the header
- **THEN** the file is rejected with an "unrecognized format" reason

#### Scenario: Altered header is rejected
- **WHEN** the header matches no known version
- **THEN** the file is rejected with an "unrecognized format" reason

#### Scenario: Bad amount rejects the file
- **WHEN** a row's card amount is `12,5x`
- **THEN** the file is rejected with a reason naming that row

#### Scenario: Empty category is accepted
- **WHEN** a row has an empty `Категорія`
- **THEN** the row is accepted

### Requirement: A PrivatBank file has one currency
Every row's card currency and balance currency SHALL be the same single currency. A file mixing them SHALL be rejected naming the row. (The existing account-currency
check then applies to that one currency.)

#### Scenario: Balance currency differs from card currency
- **WHEN** a row has card currency `UAH` and balance currency `EUR`
- **THEN** the file is rejected naming that row

### Requirement: PrivatBank balances chain across cards
The per-row balance chain (see "Balances inside a file must chain") SHALL apply to
PrivatBank files over all rows regardless of card, in the file's chronological order.
Fee is 0.

#### Scenario: Card reissue keeps the chain
- **WHEN** consecutive rows belong to two different cards of one account and the
  newer balance equals the older balance plus the newer amount
- **THEN** the chain check passes

#### Scenario: Dropped row breaks the chain
- **WHEN** a row is removed from an intact file
- **THEN** the file is rejected with the row number and expected and actual balances
