## 1. Migration

- [ ] 1.1 Add migration `0017-transactions-indexes` (indexes on `transactions` only); verify
      pglite tests: migration applies, RLS guard test still passes.

## 2. Data tools

- [ ] 2.1 Implement the `DataTool` interface and `list_accounts` / `get_account_coverage` in
      `shared/src/lib/dataTools/`; verify tests for their `data-tools` scenarios and the
      missing-identity scenario (no query made, asserted with a mocked executor).
- [ ] 2.2 Implement `list_transactions` (filters, keyset cursor, `limit + 1`,
      `LIMIT :limit::bigint`, limit validation, malformed cursor rejection); verify tests
      for pagination round-trip (120 rows), exact-page boundary, invisible account, limit
      above maximum.
- [ ] 2.3 Implement `summarize_transactions` with SQL aggregation per group and currency;
      verify the multi-currency monthly scenario.
- [ ] 2.4 Verify the untrusted-text scenario: description text appears only under the
      `untrusted` field for every tool that returns bank text.
- [ ] 2.5 Verify `pnpm exec nx run-many -t lint test build` passes; deploy migration via
      `infra:up` and confirm indexes exist.
