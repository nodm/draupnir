# telegram-rich-text Specification

## Purpose

Defines how the bot sends formatted (bold, monospace) Telegram messages: which messages
are formatted, how user-controlled text is kept from breaking or altering the markup, and
what happens if Telegram refuses the markup.

## Requirements

### Requirement: Formatting is opt-in per message
The bot SHALL send a message with Telegram HTML formatting only where that message is
explicitly built as formatted. Every other message SHALL continue to be sent as plain
text, so characters such as `<`, `&` or `_` in them are shown literally.

#### Scenario: Unformatted message is unchanged
- **WHEN** the bot sends a message that was not built as formatted (for example the
  help reply) containing the text `a<b & c`
- **THEN** the user sees exactly `a<b & c`

### Requirement: User-controlled text is escaped in formatted messages
Any text that originates from a user or an external system (account display names, bank
values, dates, and similar) SHALL be HTML-escaped before it is placed in a formatted
message, so it is displayed literally and can neither break the message nor introduce
markup of its own.

#### Scenario: Markup characters in an account name are shown literally
- **WHEN** an account is named `Joint <b>& Savings`
- **THEN** the formatted reply shows `Joint <b>& Savings` as plain characters, with no
  bold applied to the text that follows it

### Requirement: A rejected formatted message is resent as plain text
If Telegram refuses a formatted message because it cannot parse the markup, the bot
SHALL resend the same content as plain text with the formatting removed, instead of
dropping the reply.

#### Scenario: Telegram rejects the markup
- **WHEN** Telegram answers a formatted message with a "can't parse entities" error
- **THEN** the bot sends the same information once as plain text and the user still
  receives the reply

#### Scenario: Other errors are not retried as plain text
- **WHEN** Telegram answers a formatted message with any other error (for example the
  user blocked the bot)
- **THEN** the error is reported as it is today, with no plain-text resend

### Requirement: Formatted messages stay within Telegram's size limit
A formatted message SHALL stay within Telegram's 4096-character limit, counted on the
text the user sees (after markup is applied), using the same caps on listed items as
before the formatting was introduced.

#### Scenario: Maximum-size account list is accepted
- **WHEN** a user has more accounts than the list cap, each with a maximum-length name
- **THEN** the reply fits the limit and ends with a line saying how many accounts are
  not shown
