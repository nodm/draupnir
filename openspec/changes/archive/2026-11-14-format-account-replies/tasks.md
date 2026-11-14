## 1. Telegram client

- [x] 1.1 Add `parseMode?: 'HTML'` to `SendMessageOptions` and send it as `parse_mode`; verify with a `telegram.spec.ts` case that the request body carries `parse_mode: "HTML"` when set and omits it otherwise
- [x] 1.2 Add the plain-text fallback (retry once, tags stripped and `&amp; &lt; &gt;` decoded, only on HTTP 400 "can't parse entities"); verify with `telegram.spec.ts` cases for the retry, for no retry on other errors (e.g. 403), and for a second failure propagating

## 2. Formatting helpers and layouts

- [x] 2.1 Add `escapeHtml`, `bold` and `code` helpers in `bot/src/lib/accounts/format.ts`; verify with unit tests that `& < >` are escaped and nothing else changes
- [x] 2.2 Rewrite `formatAccountList` to the block layout in design.md with every dynamic value escaped; verify `format.spec.ts` covers owned/shared accounts, the not-reconciled line, the "…and N more not shown" line, and a name containing `<b>&`
- [x] 2.3 Rewrite `formatCoverage` with bold heading and titled `Imported periods` / `Gaps` / `Unclear` sections and `<code>` dates; verify specs for a gap, an unknown link, no periods, not-reconciled, and no empty `Gaps`/`Unclear` section
- [x] 2.4 Extend the worst-case length tests so the visible text (tags removed, entities decoded) of a maximum account list and maximum coverage stays under 4096 characters

## 3. Wiring

- [x] 3.1 Pass `{ parseMode: 'HTML' }` at the `/accounts` and both `/coverage` send sites in `bot/src/lib/commands/accounts.ts` (the static "no accounts" and "not available" texts stay plain); verify `accountCommands.spec.ts` asserts the option is set for the formatted replies and absent for the plain ones
- [x] 3.2 Confirm nothing stores or re-parses the sent `text` (retention deletes by message id) by reading `bot/src/lib/retention`, and note the result in the PR

## 4. Docs and verification

- [x] 4.1 Update `docs/telegram-bot.md` if it shows sample `/accounts` or `/coverage` output; verify with `grep -n "Reconciled up to" docs` that no stale sample remains
- [x] 4.2 Run `pnpm exec nx run-many -t lint test -p bot` plus `tsc --noEmit` on `bot/tsconfig.lib.json` and `bot/tsconfig.spec.json` (bot has no typecheck target) and `pnpm exec openspec validate format-account-replies --strict`; both pass
- [x] 4.3 After deploy, send `/accounts` and `/coverage` from a real phone and check bold names, monospace IBAN/dates, and a blank line between accounts
