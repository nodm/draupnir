## 1. Decision record

- [ ] 1.1 Write `docs/adr/0010-ai-assistant.md`: AI chat in the bot via the Claude API; shared
      read-only tools (also for MCP); confirm-only actions and the injection guard; data
      sent to Anthropic (with current retention terms checked at writing time); cost
      guardrails. Verify it is linked like earlier ADRs.

## 2. Data tools

- [ ] 2.1 Add migration `0005-ai-chat` (indexes on `transactions`, `chat_history`,
      `pending_actions`, `ai_usage`, policies, purge functions); verify pglite tests: RLS
      guard test passes, users can't read each other's history/actions/usage.
- [ ] 2.2 Implement the `DataTool` interface and `list_accounts` / `get_account_coverage` in
      `shared/src/lib/dataTools/`; verify tests for their `data-tools` scenarios and the
      missing-identity scenario (no query made, asserted with a mocked executor).
- [ ] 2.3 Implement `list_transactions` (filters, keyset cursor, `limit + 1`,
      `LIMIT :limit::bigint`, limit validation, malformed cursor rejection); verify tests
      for pagination round-trip (120 rows), exact-page boundary, invisible account, limit
      above maximum.
- [ ] 2.4 Implement `summarize_transactions` with SQL aggregation per group and currency;
      verify the multi-currency monthly scenario.
- [ ] 2.5 Verify the untrusted-text scenario: description text appears only under the
      `untrusted` field for every tool that returns bank text.

## 3. Assistant

- [ ] 3.1 Add `@anthropic-ai/sdk` to `bot` (use the `claude-api` skill for current model ids
      and SDK usage); implement the tool adapter, system prompt, history trimming, and tool
      loop with iteration cap and typing indicator; verify unit tests with a mocked API: a
      spending question calls tools as the user and the reply quotes their results; the
      no-data case; iteration cap reply states incompleteness.
- [ ] 3.2 Implement proposal tools, the injection guard (proposal tools removed after bank
      text in the turn), Confirm/Cancel handling, expiry, and execute-once; verify every
      `bot-ai-chat` proposal scenario and the injected-instruction scenario.
- [ ] 3.3 Implement history storage, `/reset`, and 24h purge in the retention job; record AI
      answers in `bot_messages`; verify the follow-up and reset scenarios and the purge.
- [ ] 3.4 Implement the daily budget (check-and-increment, refund on failure) and the provider
      failure reply; verify the limit, uploads-still-work, and outage scenarios.
- [ ] 3.5 Route free text to the assistant in the worker dispatcher (not during guided
      dialogues, not for unlinked users); verify the unlinked-user scenario.

## 4. Infra and live verification

- [ ] 4.1 Add the Anthropic API key secret, worker timeout/visibility-timeout changes, and
      config (model id, daily limit, iteration cap) to `infra/lib/bot.ts`; verify
      `infra:build` and `infra:preview`.
- [ ] 4.2 Manual: put the API key in the secret, `infra:up`; in Telegram ask three fixture
      questions (monthly spend, a merchant search, an account balance) and compare the answers
      with direct `data-tools` results; ask the assistant to share an account and confirm;
      check `ai_usage` counts.
- [ ] 4.3 Verify `pnpm exec nx run-many -t lint test build` passes; update
      `docs/architecture.md`.
