## ADDED Requirements

### Requirement: Owners can rename an account through a guided dialogue
`/renameaccount` SHALL let an `owner` pick one of the accounts they own (skipping the
pick when they own exactly one), then send the new display name as text. The bot SHALL
validate the name (non-empty, at most 60 characters), save it without a further confirm
step, and reply with the old and new name. Every other member of the account who is
linked to Telegram SHALL be told in their own chat who renamed it, from what to what; a
failed notification SHALL NOT fail the rename. `/cancel` SHALL abandon the dialogue, and an unfinished dialogue SHALL
expire after 1 hour. A caller who owns no account SHALL be told only an owner can
rename.

#### Scenario: Owner with several accounts renames one
- **WHEN** an owner of two accounts sends `/renameaccount`, taps one, and sends "Salary"
- **THEN** that account is named "Salary", the other is unchanged, and the bot confirms

#### Scenario: Single owned account skips the pick
- **WHEN** a user who owns exactly one account sends `/renameaccount`
- **THEN** the bot asks for the new name straight away

#### Scenario: Other members are notified
- **WHEN** an owner renames an account shared with a linked viewer
- **THEN** the viewer receives a message in their chat naming the old and new name, and
  the renaming owner is not messaged separately

#### Scenario: Unreachable member does not block the rename
- **WHEN** a member of the account is not linked to Telegram or the message to them fails
- **THEN** the account is still renamed and the owner's reply notes that nobody was
  notified (or that they could not be)

#### Scenario: Invalid name is asked again
- **WHEN** the user sends a name over 60 characters
- **THEN** the bot explains the limit and asks again, without renaming

#### Scenario: Viewer-only user is refused
- **WHEN** a user who is only a `viewer` of accounts sends `/renameaccount`
- **THEN** the bot says only an owner can rename an account and changes nothing

#### Scenario: Ownership lost mid-dialogue
- **WHEN** the user is no longer an owner of the picked account when they send the name
- **THEN** nothing is renamed and the bot says so
