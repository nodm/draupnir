## 1. Data

- [x] 1.1 Add `balanceMinorUnits`, `balanceAsOf`, `balanceReconciled` to `MemberAccount` and select them in `listMemberAccounts` (`bot/src/lib/memberAccounts.ts`); verify with its spec/unit test and update fixtures that build `MemberAccount`
- [x] 1.2 Confirm `formatMinorUnits` in `shared/src/lib/money.ts` handles EUR, JPY (0 decimals), 3-decimal currencies and negatives; add tests only for gaps

## 2. Formatting

- [x] 2.1 Add the balance line to `formatAccountList` in `bot/src/lib/accounts/format.ts` per design.md, escaped, with the "(not reconciled)" marker; verify `format.spec.ts` covers reconciled, unreconciled, negative and JPY cases
- [x] 2.2 Update the worst-case length test so a maximum account list stays under 4096 visible characters

## 3. Wiring and docs

- [x] 3.1 Confirm `accountCommands.spec.ts` `/accounts` case shows the balance end to end (fixtures include balance fields)
- [x] 3.2 Update the `/accounts` row in `docs/telegram-bot.md` to mention balance; verify with `grep -n "/accounts" docs/telegram-bot.md`

## 4. Verification

- [x] 4.1 Run `pnpm exec nx run-many -t lint test -p bot shared`, `tsc --noEmit` on `bot/tsconfig.lib.json` and `bot/tsconfig.spec.json`, and `pnpm exec openspec validate show-balance-in-accounts-reply --strict`; all pass
- [ ] 4.2 After deploy, send `/accounts` from a phone and check balance, as-of date and unreconciled marker
