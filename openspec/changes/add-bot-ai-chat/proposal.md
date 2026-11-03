## Why

The point of collecting statements is to ask questions about them ("how much
did we spend on groceries in March?", "what's left on the Revolut account?").
With Telegram as the only interface, the natural place to ask is the same chat.
Free text currently gets a help reply. The same data access should also serve
Claude Desktop through the MCP server, so it has to be defined once.

Depends on `add-telegram-bot` (chat, linking, retention) and
`add-row-level-security` (tools run as the caller).

## What Changes

- New read-only **data tools** in `shared`, each with a name, description,
  input schema, and handler that runs as the calling user under RLS:
  - `list_accounts`;
  - `list_transactions` (account, date range, text filter, pagination);
  - `summarize_transactions` (totals per currency grouped by month, account,
    or description, over a date range);
  - `get_account_coverage`.
- The bot worker sends non-command text from a linked user to the Claude API
  with these tools, runs the tool loop, and replies with the answer. A typing
  indicator shows while it works.
- The AI can **propose** changes but never make them:
  - "create account" and "share account" proposals become a confirm/cancel
    message;
  - only the user's button press runs the change, through the same domain
    functions as the bot commands;
  - proposals expire after 10 minutes.
- Bank-provided text (descriptions, counterparty names) is passed to the model
  as untrusted data, so instructions in it can't trigger anything, since no
  tool writes.
- Per-user chat history is stored for context, trimmed per request, cleared by
  `/reset`, and deleted after 24 hours.
- Cost guardrails:
  - a per-user daily request budget;
  - a maximum number of tool iterations per answer;
  - a configurable model id;
  - the API key in Secrets Manager.
- AI answers are recorded for the 24-hour deletion (`telegram-message-retention`
  already covers "later AI answers").

## Capabilities

### New Capabilities
- `data-tools`: the shared, read-only, caller-scoped data tools and their
  input/output contracts, reused by the bot's AI chat and the MCP server.
- `bot-ai-chat`: answering questions in the Telegram chat with the data tools,
  confirmed actions, untrusted-data handling, history, and cost limits.

### Modified Capabilities
(none — retention of AI answers is already required by
`telegram-message-retention`)

## Impact

- `shared/src/lib/dataTools/`: tool definitions (JSON schema + handler) and
  query helpers. They use `withCaller`, membership predicates, and keyset
  pagination (indexes on `transactions(account_id, posted_date, id)` and
  `transactions(posted_date, id)` via migration `0005`).
- `bot/`:
  - the Claude API client and tool loop;
  - the pending-action flow;
  - chat history and budgets: migration `0005` adds `chat_history`,
    `pending_actions`, and `ai_usage`, all with RLS.
- New dependency: `@anthropic-ai/sdk`.
- `infra/lib/bot.ts`: an Anthropic API key secret, and a worker timeout and
  memory sized for the tool loop.
- Running cost: Claude API usage becomes the largest variable cost of the
  system, bounded by the daily budget.
- `add-mcp-data-tools` (to be revised) will expose the same `data-tools`.
