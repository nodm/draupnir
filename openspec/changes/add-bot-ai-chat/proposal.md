## Why

The point of collecting statements is to ask questions about them ("how much
did we spend on groceries in March?", "what's left on the Revolut account?").
With Telegram as the only interface, the natural place to ask is the same chat.
Free text currently gets a help reply.

Depends on `add-telegram-bot` (chat, linking, retention) and `add-data-tools`
(the shared read-only tools, defined once for every AI surface). Lower priority
than `add-mcp-data-tools`.

## What Changes

- The bot worker sends non-command text from a linked user to the Claude API
  with the `add-data-tools` tools, runs the tool loop, and replies with the answer. A typing
  indicator shows while it works.
- The AI can **propose** changes but never make them:
  - "create account" and "share account" proposals become a confirm/cancel
    message;
  - only the user's button press runs the change, through the same domain
    functions as the bot commands;
  - proposals expire after 10 minutes.
- Bank-provided text (descriptions, counterparty names) is passed to the model
  as untrusted data. Proposals are built in a separate, clean model call that
  sees only the user's current message and their own account list (no history
  or tool results). A share recipient must appear verbatim in that message, so
  injected text, even quoted in an earlier answer, can't pick a recipient or
  trigger a change.
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
- `bot-ai-chat`: answering questions in the Telegram chat with the data tools,
  confirmed actions, untrusted-data handling, history, and cost limits.

### Modified Capabilities
(none — retention of AI answers is already required by
`telegram-message-retention`)

## Impact

- `bot/`:
  - the Claude API client and tool loop;
  - the pending-action flow;
  - chat history and budgets: migration `0018` adds `chat_history`,
    `pending_actions`, and `ai_usage`, all with RLS.
- New dependency: `@anthropic-ai/sdk`.
- `infra/lib/bot.ts`: an Anthropic API key secret, and a worker timeout and
  memory sized for the tool loop.
- Running cost: Claude API usage becomes the largest variable cost of the
  system, bounded by the daily budget.
