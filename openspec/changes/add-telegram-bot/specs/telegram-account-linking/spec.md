## Purpose

Binds a Telegram user to exactly one Draupnir identity (a Google account
through the Cognito user pool), so every bot interaction acts as that identity
and nothing else.

## ADDED Requirements

### Requirement: Linking goes through Google sign-in
When an unlinked Telegram user sends `/start` (or any message), the bot SHALL
reply with a sign-in link to the Cognito hosted login, using the same user
pool, Google federation, and sign-up allowlist as the rest of Draupnir. The
link SHALL carry a one-time, unguessable state value bound to that Telegram
user and SHALL expire 10 minutes after it is issued. Completing sign-in SHALL
record a link between the Telegram user id and the signed-in user's `sub`, and
the bot SHALL confirm in the chat which Google email it is linked to.

#### Scenario: Successful link
- **WHEN** an unlinked Telegram user taps the sign-in link and signs in with an
  allowlisted Google account within 10 minutes
- **THEN** their Telegram user id is linked to that account's `sub`, and the bot
  sends a confirmation naming the account's email

#### Scenario: Expired or reused link is refused
- **WHEN** the sign-in callback receives a state value that has expired or has
  already been used
- **THEN** no link is created and the browser page tells the user to send
  `/start` again

#### Scenario: Non-allowlisted Google account cannot link
- **WHEN** a Telegram user signs in through the link with a Google account not
  on the allowlist
- **THEN** sign-in fails as it does elsewhere and no link is created

### Requirement: A Telegram user and an identity are linked one-to-one
A Telegram user id SHALL be linked to at most one `sub`, and a `sub` to at most
one Telegram user id. Linking a Telegram user or a `sub` that is already linked
SHALL be refused, with a message to `/unlink` first.

#### Scenario: Second Telegram account for the same Google account is refused
- **WHEN** a `sub` already linked to one Telegram user completes sign-in from a
  link issued to a different Telegram user
- **THEN** no new link is created and the second Telegram user is told the
  Google account is already linked elsewhere

### Requirement: Unlinked users can only link
The bot SHALL NOT perform any action (upload, commands, chat) for a Telegram user
who is not linked, other than replying with the sign-in link.

#### Scenario: Unlinked user sends a file
- **WHEN** an unlinked Telegram user sends a CSV file
- **THEN** the file is not processed or stored, and the bot replies with the
  sign-in link

### Requirement: A user can unlink
`/unlink` SHALL remove the caller's link immediately; their next message SHALL be
treated as coming from an unlinked user.

#### Scenario: Unlink takes effect immediately
- **WHEN** a linked user sends `/unlink` and then `/accounts`
- **THEN** the link is removed and the `/accounts` reply is the sign-in link, not
  an account list
