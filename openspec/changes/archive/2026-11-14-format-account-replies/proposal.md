## Why

The `/accounts` reply packs name, bank, masked IBAN, currency and role onto one line
separated by `·`, with the reconciliation status on an indented second line. With more
than one account it is a wall of similar-looking text, and `/coverage` has the same
problem: headings, periods and gaps all look alike. Telegram can render rich text, but
the bot only sends plain text, so nothing can be emphasised.

## What Changes

- The bot can send a message with Telegram's **HTML** parse mode (opt-in per message;
  every other message stays plain text and is unaffected).
- `/accounts` is reformatted: one block per account with the display name in bold, then
  the bank, masked IBAN (monospace), currency and role on a second line, then the
  reconciliation status, with a blank line between accounts.
- `/coverage` is reformatted: bold account heading and section titles (`Imported
  periods`, `Gaps`, `Unclear`), dates in monospace, the reconciled/not-reconciled
  status first.
- All user-controlled text placed in these messages (account display names, bank values)
  is HTML-escaped, so a name like `A<B & C` renders literally and can never break the
  message or inject markup.
- The content and the length caps of both replies do not change; only presentation does.

HTML is chosen over MarkdownV2 because it only needs `<`, `>` and `&` escaped, while
MarkdownV2 requires escaping 18 punctuation characters (including `.`, `-`, `(`, `)`),
which appear all over account names and dates.

## Capabilities

### New Capabilities

- `telegram-rich-text`: how the bot sends formatted messages: the HTML parse mode,
  mandatory escaping of user-controlled text, and a plain-text fallback when Telegram
  rejects the markup.

### Modified Capabilities

- `telegram-account-commands`: the `/accounts` and `/coverage` replies are laid out as
  structured, formatted messages (the information they carry is unchanged).

## Impact

- `bot/src/lib/telegram.ts`: `SendMessageOptions` gains a `parseMode`; the client passes
  it as `parse_mode`.
- `bot/src/lib/accounts/format.ts` (+ spec): new layout, escaping helper.
- `bot/src/lib/commands/accounts.ts`: the two send sites request HTML.
- `docs/telegram-bot.md`: sample replies, if the guide shows any.
- No infrastructure, database, API or dependency changes. No new permissions.
- Out of scope: the other command replies (`/newaccount`, `/share`, upload outcomes,
  help) and the free-text answers of the in-flight `add-bot-ai-chat` change; they can
  adopt the same helper later.
