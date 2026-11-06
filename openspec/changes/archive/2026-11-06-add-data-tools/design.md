## Context

- `add-row-level-security` provides `withCaller(sub, fn)`.
- `transactions` has no indexes beyond its PK and `UNIQUE (account_id,
  dedup_key)`.
- Keyset pagination: `(posted_date, id)` cursor, `limit + 1` fetch, `LIMIT
  :limit::bigint` because the Data API sends JS numbers as doubles.

## Goals / Non-Goals

**Goals:**
- One tool layer for every AI surface (MCP first, bot assistant later).
- Results grounded in SQL; no data logic in adapters.

**Non-Goals:**
- Adapters for MCP or the Claude API (separate changes).
- Write tools, categorisation, charts.

## Decisions

### 1. Tool definitions live in `shared`, independent of any AI SDK

```ts
interface DataTool<I, O> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  run(ctx: { sub: string; db: DbContext }, input: I): Promise<O>;
}
```

- Input is validated with zod derived from the same definition. Output
  separates system fields from `untrusted: { description, counterparty }`
  (spec: "Bank-provided text is marked as untrusted").
- Each AI surface adapts these definitions to its own API. Adapters have no
  data logic.
- `summarize_transactions` aggregates in SQL (`GROUP BY` group key, currency),
  so a model never receives thousands of rows to add up itself.

### 2. Migration `0017-transactions-indexes`

`transactions(posted_date, id)` and `transactions(account_id, posted_date, id)`
for keyset pagination. Indexes only, so it is safe on prod data and can ship
before any bot tables (`add-bot-ai-chat` adds those in `0018`).

## Risks / Trade-offs

- **Index build on a live table.** → Table is small (two users); plain
  `CREATE INDEX` is acceptable.
- **Breaking a tool contract affects every surface.** → Intended: one contract,
  covered by this change's tests.

## Migration Plan

- Additive: new module and two indexes. Rollback: revert; drop the indexes.
