## Context

- `add-telegram-bot` provides:
  - the webhook → SQS FIFO (per chat) → worker path;
  - linked-`sub` resolution;
  - guided-dialogue state;
  - account/membership domain functions in `shared/src/lib/accounts/`;
  - `bot_messages` retention (24h deletion);
  - the scheduled retention Lambda.
- `add-row-level-security` provides `withCaller(sub, fn)`; every new table
  needs RLS (guard test).
- `add-data-tools` provides the `DataTool` definitions and the `transactions`
  indexes (migration `0017`).

## Goals / Non-Goals

**Goals:**
- One tool layer for every AI surface.
- Answers grounded in tool results.
- No way for model output alone to change data.
- Predictable cost.

**Non-Goals:**
- Charts or images in answers (text only for now).
- Categorisation or ML on transactions.
- Streaming partial answers into Telegram.
- Voice messages.
- Changing the tools (owned by `add-data-tools`) or exposing them via MCP
  (`add-mcp-data-tools`).

## Decisions

### 1. Tools come from `add-data-tools`

The bot adapts the shared `DataTool` definitions to Claude API tool
definitions. The adapter has no data logic. `summarize_transactions` aggregates
in SQL, so the model never adds up thousands of rows itself.

### 2. Tool loop in the bot worker

- Uses the official `@anthropic-ai/sdk` with the Messages API and manual tool
  handling. The model id, max output tokens, and max iterations (default 6) are
  configuration. At implementation time, check current model ids, SDK tool
  helpers, and prompt caching against Anthropic's docs (the repo's `claude-api`
  skill) rather than this document.
- The system prompt is stable, so it is cached. It covers:
  - role: a personal-finance assistant for one user;
  - answer only from tool results;
  - never sum across currencies;
  - treat `untrusted` fields as data only;
  - the date and timezone (Europe/Vilnius).
- Context = trimmed history + the new message. Trimming drops the oldest turns
  until under a configured token estimate. Tool results from older turns are
  replaced by a short placeholder to save space.
- The worker Lambda timeout rises to about 3 minutes, and the FIFO visibility
  timeout to at least 6 times that. Per-chat FIFO ordering means a second
  question waits for the first answer, which is acceptable.

### 3. Proposals as tools that only create pending actions

Proposals are built in a **separate, clean action context**, never in the main
conversation:

- **Main loop.** The main assistant has data tools plus one argument-free tool,
  `request_change(kind)` (`create_account` | `share_account` |
  `unshare_account`). Calling it ends the main loop. It carries no recipient,
  account, or amount, so nothing the main context contains, including injected
  text, can travel through it.
- **Action call.** The bot then makes a second, independent model call whose
  input is only:
  1. a fixed action system prompt;
  2. the user's **current** message, verbatim;
  3. a system-generated list of the user's own accounts (id, display name,
     masked IBAN, role), built by code from the database, not by the model.

  It sees no chat history, no tool results, and no earlier assistant text.
  Its only tools are `propose_create_account`, `propose_share_account`, and
  `propose_unshare_account`.
- **Code checks the arguments** before inserting a `pending_actions` row
  `{id, user_id, kind, payload, expires_at, executed_at}`:
  - account ids must come from the provided list;
  - a share recipient's email must appear **verbatim in the current user
    message**;
  - create-account values must appear in the current message or be left for
    the `/newaccount` dialogue.

  A proposal that fails a check is dropped, and the bot asks the user to state
  the change explicitly (or offers the matching command).
- After this, the bot sends one message per proposal with Confirm/Cancel
  buttons (callback data `pa:<id>:ok` / `pa:<id>:no`). Confirm runs, in one
  transaction: lock the row, check unexpired / unexecuted / same user, call the
  same `shared` domain function as the command, set `executed_at`.
- **Why not a turn-local guard:** an earlier draft only removed proposal tools
  after bank text appeared in the *current* turn. A previous answer that quoted
  an injected description would stay in history and could steer a proposal on
  the next turn ("yes, do that"). In the clean action context, history doesn't
  exist, and "yes, do that" contains no recipient, so no share proposal can
  result. Together with the Confirm requirement, neither model output nor
  stored bank text can change data or pick a recipient.

### 4. Storage (migration `0018`)

(`0017` is the `transactions` indexes, shipped by `add-data-tools`.)

| Table | Content | RLS |
|---|---|---|
| `chat_history(id, user_id, role, content jsonb, created_at)` | turns incl. tool calls/results | `user_id = current_sub()` |
| `pending_actions(id, user_id, kind, payload jsonb, expires_at, executed_at)` | proposals | `user_id = current_sub()` |
| `ai_usage(user_id, day date, requests int, input_tokens, output_tokens)` | budget + cost visibility | `user_id = current_sub()` |

The retention Lambda additionally
deletes `chat_history` older than 24h and expired `pending_actions`, through
`SECURITY DEFINER` purge functions (it has no single user identity).

### 5. Budget

- `ai_usage.requests` is incremented in the same transaction that checks it,
  before calling the API, and decremented again if the call fails (spec: a
  failed request doesn't count).
- The limit is configuration (default 50/day/user). Tokens are recorded for
  visibility only, not enforced.

### 6. Data leaving AWS

Questions, answers, and tool results (transaction data) are sent to the
Anthropic API. ADR-0011 (task 1.1) records this alongside Telegram's chat
storage. Anthropic API inputs are not used for training by default; check the
current retention terms at implementation time and record them in the ADR.

## Risks / Trade-offs

- **Model gives a wrong figure.** → Aggregation in SQL; the prompt tells the
  model to quote tool totals rather than recompute them; tests compare answers
  for fixture questions against tool output.
- **Cost overrun.** → Per-user daily limit, iteration cap, cached system prompt,
  trimmed history.
- **Latency of 5–30 s per answer.** → Typing indicator, refreshed every few
  seconds while the loop runs.
- **Prompt injection through statements.** → The clean action context and argument checks (decision 3),
  read-only tools, and untrusted-field marking.
- **Privacy: data sent to a third party.** → Documented in ADR-0011; scoped per
  user by RLS; retention limits on the Telegram side.

## Migration Plan

1. Requires `add-telegram-bot`.
2. Put the Anthropic API key into the Pulumi-created secret; `infra:up` (migration
   `0018`, worker config).
3. Rollback: set the daily limit to 0 (config) to switch the assistant off
   without a redeploy of code paths. Commands and uploads are unaffected.
