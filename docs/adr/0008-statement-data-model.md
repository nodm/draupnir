# ADR-0008: Statement Data Model (raw rows + derived transactions + account membership)

## Status

Accepted

## Date

2026-11-03

## Deciders

Dmytro Novikov

## Context

The first schema kept only what the parsers normalize
([ADR-0004](./0004-ingestion-flow-shape.md)). Everything else a bank exports (balance
after each row, fees, MCC, counterparty, the bank's own state/product columns) was
discarded and could never be re-derived. Accounts had exactly one owner, so a joint
account could not be shared; `UNIQUE(iban)` / `UNIQUE(dedup_key)` spanned all users, which
both leaks other users' data once RLS lands and can silently drop a transaction that
collides with a row the uploader cannot see. There was no record of which files were
imported, approved, or rejected, and no check that an import was complete.

Access to Aurora stays RDS Data API only ([ADR-0003](./0003-aurora-access-pattern.md)),
so whatever we choose must work with a single Data API transaction per import and the
4 MiB request cap.

## Decision

Three storage layers plus membership-based access:

1. **Original CSV** stays in S3, unchanged (byte-exact source).
2. **Raw rows** (`raw_rows`): every row of an approved file as `jsonb` (header → original
   cell string), tagged with bank, format version, row number, and the bank's
   transaction id where one exists. Per-file records live in `statement_files` (uploader
   only) and `statement_file_accounts` (per resolved account: periods, balances, counts,
   warnings).
3. **Derived common table** (`transactions`): rebuildable from raw rows; linked to every
   raw row it came from through `transaction_sources`; unique on `(account_id, dedup_key)`.

Access is by `account_members` (`owner` | `viewer`), replacing `owner_user_id` columns and
`share_grants`. Every account-scoped table carries its own `account_id`, so row-level
policies are a uniform membership check.

Whole files are validated per (bank, format version) and approved or rejected as a unit.
Tiers: hard rejects (unknown format, broken balance chain, disagreement with stored
transactions, same file re-imported) vs. warnings (does not connect to stored history or
the opening balance), reported as coverage gaps.

## Options Considered

| Option                                        | Lossless | Rebuildable | Single-tx import | Real FKs | DDL per bank/format         |
| --------------------------------------------- | -------- | ----------- | ---------------- | -------- | --------------------------- |
| **jsonb raw rows + derived table — chosen**   | Yes      | Yes         | Yes              | Yes      | No                          |
| Table per bank (typed raw columns)            | Yes      | Yes         | Yes              | Yes      | Yes, on every format change |
| Separate document store (DynamoDB/DocumentDB) | Yes      | Yes         | No               | No       | No                          |
| Single owner + `share_grants` (status quo)    | n/a      | n/a         | n/a              | n/a      | n/a                         |
| Dedup at the raw level (only keep new rows)   | No       | No          | Yes              | Yes      | No                          |

## Trade-off Analysis

- **Table per bank** needs a migration for every new bank and every format revision and
  gives `transaction_sources` no single table to reference. `jsonb` plus a zod schema per
  format version moves format knowledge into code, where it is testable.
- **Document DB** would add a second datastore, lose the one-transaction import (raw rows,
  derived rows, and links could drift), and prevent a real FK from `transaction_sources`.
- **Single owner + share grants** can't express a joint account, and per-row owner columns
  duplicate what the account already says. Membership is one concept for owners and viewers.
- **Dedup at raw level** loses what overlapping statements said. Keeping every raw row and
  deduplicating only in `transactions` lets overlapping files produce one transaction with
  several sources, and makes the overlap-agreement check possible.
- **Costs of the chosen model:** two layers of truth (raw vs. derived) can drift if
  derivation changes, answered by a routine `rebuildAccount`; `jsonb` does not preserve key
  order (the S3 object does); larger Data API payloads, answered by byte-based chunking.

## Consequences

- Migration `0002` drops and recreates `accounts`, `transactions`, `share_grants` (test
  data only; confirmed before deploy).
- `ownershipPredicate` / `assertCanMutateGrant` are replaced by membership helpers.
- Parsers emit raw payload + format version alongside normalized rows; validation modules
  per bank and format version (zod) approve or reject whole files.
- `add-row-level-security` builds policies on these tables; `add-telegram-bot` and
  `add-mcp-data-tools` build on the membership and coverage data.

## Action Items

- [ ] Confirm whether Revolut uses one IBAN per currency (assumption in design.md
      decision 5).
- [ ] Revisit SEB balance checks once a sample export with balances is available.
