## Why

MCP clients (Claude Desktop, Claude Code) can't read any of the user's data
yet, and that is now the priority. The Telegram AI chat (`add-bot-ai-chat`)
will need the same data access later. Defining the read-only, caller-scoped
tools once, in `shared`, lets both surfaces reuse them, and lets MCP ship
without waiting for the assistant.

Depends on `add-row-level-security` (tools run as the caller) and
`redesign-statement-data-model`.

## What Changes

- New read-only **data tools** in `shared/src/lib/dataTools/`, each with a name,
  description, input schema, and handler that runs as the calling user under
  RLS:
  - `list_accounts`;
  - `list_transactions` (account, date range, text filter, keyset pagination);
  - `summarize_transactions` (totals per currency grouped by month, account, or
    description, over a date range);
  - `get_account_coverage`.
- Migration `0017-transactions-indexes`: `transactions(account_id, posted_date,
  id)` and `transactions(posted_date, id)`. Indexes only, no new tables.
- Bank-provided text is returned only in fields marked untrusted.
- Out of scope: any AI SDK adapter (MCP: `add-mcp-data-tools`; Claude API:
  `add-bot-ai-chat`), write tools.

## Capabilities

### New Capabilities
- `data-tools`: the shared, read-only, caller-scoped data tools and their
  input/output contracts.

### Modified Capabilities
(none)

## Impact

- `shared/src/lib/dataTools/`: tool definitions and query helpers (`withCaller`,
  membership predicates, keyset pagination).
- One additive migration (indexes). No behavior change for existing code.
- No infra changes.
