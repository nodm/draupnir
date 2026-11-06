# ADR-0010: Shared Read-Only Data Tools, Exposed over MCP First

## Status

Accepted

## Date

2026-11-06

## Deciders

Dmytro Novikov

## Context

The MCP server ([ADR-0001](./0001-mcp-transport.md)) is deployed with only a `whoami` tool, so
Claude Desktop and Claude Code can't read any data. A Telegram AI assistant
(`add-bot-ai-chat`) will need the same data access. Identity is the Cognito `sub`, and data
access runs as the caller under row-level security ([ADR-0003](./0003-aurora-access-pattern.md)).
MCP is now the higher priority.

## Decision

- Define four **read-only** tools once in `shared` (`add-data-tools`): `list_accounts`,
  `list_transactions`, `summarize_transactions`, `get_account_coverage`. Each runs inside
  `withCaller(sub, …)`, so RLS scopes every result to the caller.
- Expose them over MCP through a thin adapter (`add-mcp-data-tools`). `mcp` holds no data logic.
  `sub` comes only from the authorizer claim; no `sub`, no query.
- The Telegram assistant is a later, separate change that adapts the same tools to the Claude
  API. It does not block MCP.
- **No write tools** over MCP. Changes stay in the bot's confirm-only flow.
- Bank-provided text is returned only in fields marked untrusted, so any client can treat it as
  data, not instructions.
- Migrations are split: `0017` (this work) adds only the `transactions` indexes; bot tables
  (`0018`) ship with the assistant, so prod gets no unused tables.

## Options Considered

| Option                                   | Duplication | MCP ships first | Notes                         |
| ---------------------------------------- | ----------- | --------------- | ----------------------------- |
| **Shared tools in `shared`, adapters — chosen** | None | Yes          | One contract for all surfaces |
| Tools inside `mcp`, bot re-implements    | High        | Yes             | Two views of the data drift   |
| Tools inside `bot`, MCP waits            | None        | No              | Contradicts the priority      |

## Consequences

- A tool contract change affects every AI surface; the `data-tools` tests are the guard.
- MCP clients still need a manually obtained Cognito JWT; OAuth discovery stays the open item of
  ADR-0001/0002.
- Transaction data is sent to whichever MCP client the user connects. That is the user's own
  client and choice; it is not stored by Draupnir.
- `mcp` Lambda gains Data API access with the `draupnir_app` credential (RLS applies).

## Action Items

- [ ] Implement `add-data-tools`, then `add-mcp-data-tools`.
- [ ] ADR-0011 (AI assistant, Claude API, data sent to Anthropic) is written with `add-bot-ai-chat`.
