## MODIFIED Requirements

### Requirement: A sent statement is attached to an account the user owns
When a linked user sends a document, the bot SHALL accept it only if:
- it is a CSV;
- it is within Telegram's bot download limit;
- the user is an `owner` member of at least one account.

The bot SHALL then choose the account:
- an SEB file whose header IBAN matches exactly one account the user owns is
  attached to that account automatically;
- a Swedbank file whose rows name exactly one IBAN, matching exactly one Swedbank
  account the user owns, is attached to that account automatically;
- otherwise the bot SHALL ask with buttons listing the accounts the user owns.

A pending choice SHALL expire after 1 hour.

#### Scenario: Account chosen from buttons
- **WHEN** a user who owns two accounts sends a Revolut CSV and taps one of the
  offered accounts
- **THEN** the file is handed to ingestion for that account

#### Scenario: SEB file auto-selects its account
- **WHEN** a user sends an SEB CSV whose header IBAN matches one account they own
- **THEN** the file is handed to ingestion for that account without asking

#### Scenario: Swedbank file auto-selects its account
- **WHEN** a user who owns two Swedbank accounts sends a Swedbank CSV whose rows
  name the IBAN of one of them
- **THEN** the file is handed to ingestion for that account without asking

#### Scenario: Swedbank file for an unknown account asks
- **WHEN** a user sends a Swedbank CSV whose IBAN matches no account they own
- **THEN** the bot asks with buttons listing the accounts they own

#### Scenario: Viewer-only user cannot upload
- **WHEN** a user who is only a `viewer` of every account they belong to sends a
  CSV
- **THEN** the file is not processed and the bot explains that an owner must
  import it or create their own account first

#### Scenario: Non-CSV document is refused
- **WHEN** a user sends a PDF
- **THEN** it is not processed and the bot says only CSV exports are supported
