## Context

`account-balances` stores `balance_minor_units`, `balance_as_of`, `balance_reconciled` on `accounts`. The MCP `list_accounts` tool already returns them. The bot's `listMemberAccounts` selects only identity columns, and `formatAccountList` (HTML, see `telegram-rich-text`) shows no balance.

## Goals / Non-Goals

**Goals:** show stored balance, as-of date and reconciled flag per account in `/accounts`.

**Non-Goals:** balance in `/coverage`; running balances; any recomputation in the bot; changing the balance rules.

## Decisions

- **Read the stored columns in `listMemberAccounts`**, extending `MemberAccount` with `balanceMinorUnits`, `balanceAsOf`, `balanceReconciled`. One query, RLS unchanged. Alternative (reuse shared `listAccounts` tool) rejected: it also computes coverage, which `/accounts` already fetches separately.
- **Format with shared money helpers** (`minorUnitExponent` in `shared/src/lib/money.ts`), so zero/three-decimal currencies scale correctly. Reuse the existing `formatMinorUnits(minor, currency)` from `shared`; display as `<amount> <currency>`, e.g. `1069.50 EUR`.
- **Layout**: new line after bank/IBAN line: `Balance <code>1069.50 EUR</code> as of <code>2026-08-29</code>`; when not reconciled append ` (not reconciled)`. The existing "Reconciled up to" line stays.
- Balance text goes through `code()`/`escapeHtml` like all dynamic values. Worst-case length: add ~70 chars per account × 20 accounts; re-run the existing 4096 length test.

## Risks / Trade-offs

- Stored balance is a number the user may treat as bank-confirmed → the not-reconciled marker mitigates.
- A shared account shows its balance to `viewer` members too; they already see its transactions, so no new exposure.
