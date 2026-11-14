## Context

See proposal.md for motivation. Today every bot message goes through
`TelegramClient.sendMessage(chatId, text, { replyMarkup })` in `bot/src/lib/telegram.ts`,
which posts `{ chat_id, text, reply_markup }` with no `parse_mode`. The `/accounts` and
`/coverage` replies are built as plain strings by `formatAccountList` and
`formatCoverage` in `bot/src/lib/accounts/format.ts`, and sent from
`bot/src/lib/commands/accounts.ts`. Account display names are user-supplied (up to 60
characters), so they are untrusted when placed in markup.

Telegram's two usable rich-text modes are `HTML` and `MarkdownV2`. Neither supports
tables. HTML offers `<b>`, `<i>`, `<code>`, `<pre>` and `<blockquote>`.

## Goals / Non-Goals

**Goals:**
- A readable, structured layout for `/accounts` and `/coverage` using bold and monospace.
- A small, reusable mechanism so other replies can adopt formatting later.
- No change to what information is shown, nor to the existing length caps.

**Non-Goals:**
- Reformatting other replies (`/newaccount`, `/share`, upload outcomes, help) or the AI
  chat answers of `add-bot-ai-chat`.
- Tables, `<pre>` grids, emoji decoration or localisation.
- Changing the webhook, queues or any infrastructure.

## Decisions

### HTML parse mode, not MarkdownV2
MarkdownV2 requires escaping `_ * [ ] ( ) ~ ` > # + - = | { } . !` everywhere in
text. Account names, dates (`2026-03-31`) and the `…` mask would all need it, and a
single missed character makes Telegram reject the whole message. HTML needs only `& < >`
escaped. *Alternative considered:* legacy `Markdown`; rejected because it cannot escape
inside code/bold reliably and is documented as kept only for compatibility.

### Opt-in per message through `SendMessageOptions.parseMode`
`sendMessage` gets `parseMode?: 'HTML'`, passed through as `parse_mode`. The default
stays plain text, so the ~68 existing `sendMessage` call sites (and anything that
interpolates user text, such as the Telegram display name or error text) are untouched.
*Alternative considered:* make HTML the default for all messages; rejected because every
existing message would then need escaping audited at once, and an unescaped `<` in any
of them would turn into a failed send.

### A single `escapeHtml` helper and formatters that return HTML
`format.ts` gains a small `escapeHtml` (`&`, `<`, `>`) and a few tiny helpers (`bold`,
`code`) so every interpolated value passes through one place. `formatAccountList` and
`formatCoverage` return HTML strings and escape every dynamic value, including dates
and bank names, not only display names (cheap, and removes a class of "was this one
safe" questions). The send sites in `accounts.ts` pass `{ parseMode: 'HTML' }`.
The existing static texts (`You have no accounts yet…`) contain no markup characters
and stay as they are. The existing exported `accountLabel` (used for button captions,
which are plain text) is not changed; the coverage heading builds its own escaped,
formatted variant.

### Layout
`/accounts`:

```
<b>Your accounts</b>

<b>1. SEB main</b> (owner)
SEB · <code>…1000</code> · EUR
Reconciled up to <code>2026-03-31</code>

<b>2. Savings</b> (viewer)
Revolut · <code>…4321</code> · EUR
Not reconciled yet
```

`/coverage`: bold heading (`Coverage of <b>SEB main</b> (<code>…1000</code>)`), the
status line, then `<b>Imported periods</b>`, `<b>Gaps</b>`, `<b>Unclear</b>` sections
whose items keep the existing `•` bullets and put dates in `<code>`. Section selection
and caps (`MAX_LISTED_*`) are unchanged.

### Plain-text fallback on a parse error
In the real client, a formatted `sendMessage` that fails with HTTP 400 and a
description containing `can't parse entities` is retried once without `parse_mode`,
with tags stripped and the three entities decoded. Any other error propagates as
today. Escaping makes this a safety net, not a normal path. *Alternative considered:*
no fallback; rejected because a user would silently get no reply to `/accounts` over a
formatting bug, and the worker would retry the whole update.

### Length
Telegram measures the 4096 limit on the text after entity parsing, so tags do not count
against it, and the existing caps (20 accounts, 30 periods, 15 problems per kind) that
already keep the plain version under the limit still hold. Only the added headings and
blank lines are new; the worst-case test is extended to assert the visible text (tags
removed) stays under 4096.

## Risks / Trade-offs

- [A dynamic value reaches the message unescaped] → all interpolation goes through
  the helpers, a test with `<`, `&` and `>` in the name covers both replies, and the
  plain-text fallback keeps the reply from being lost.
- [Existing tests assert exact plain strings (`1. SEB main · SEB · …1000 · EUR · owner`)]
  → they are updated to the new layout; expected, not a regression.
- [Clients that render HTML differently, such as older Telegram versions] → only
  `<b>` and `<code>`, which every client supports.
- [Message-retention or logging code stores `text`] → it would now hold HTML; the
  retention job deletes by message id and is unaffected, to be confirmed in the tasks.
