> Requires `add-data-tools` (data tools + migration `0017`) first. Lower priority than
> `add-mcp-data-tools`.

## 1. Decision record

- [ ] 1.1 Write `docs/adr/0011-ai-assistant.md`: AI chat in the bot via the Claude API; shared
      read-only tools (`add-data-tools`, ADR-0010); confirm-only actions and the injection guard; data
      sent to Anthropic (with current retention terms checked at writing time); cost
      guardrails. Verify it is linked like earlier ADRs.

## 2. Assistant

- [ ] 2.0 Add migration `0018-ai-chat` (`chat_history`, `pending_actions`, `ai_usage`,
      policies, purge functions); verify pglite tests: RLS guard test passes, users can't
      read each other's history/actions/usage.
- [ ] 2.1 Add `@anthropic-ai/sdk` to `bot` (use the `claude-api` skill for current model ids
      and SDK usage); implement the tool adapter, system prompt, history trimming, and tool
      loop with iteration cap and typing indicator; verify unit tests with a mocked API: a
      spending question calls tools as the user and the reply quotes their results; the
      no-data case; iteration cap reply states incompleteness.
- [ ] 2.2 Implement `request_change`, the clean action context (current message + code-built
      account list only), proposal tools with argument checks (ids from the list, recipient
      email verbatim in the current message), Confirm/Cancel handling, expiry, and
      execute-once; verify every `bot-ai-chat` proposal scenario, the injected-instruction
      scenario, and the two-turn case (an injected address quoted in an earlier answer +
      "ok, do that" → no proposal), asserting the action call's input contains no history
      or tool results.
- [ ] 2.3 Implement history storage, `/reset`, and 24h purge in the retention job; record AI
      answers in `bot_messages`; verify the follow-up and reset scenarios and the purge.
- [ ] 2.4 Implement the daily budget (check-and-increment, refund on failure) and the provider
      failure reply; verify the limit, uploads-still-work, and outage scenarios.
- [ ] 2.5 Route free text to the assistant in the worker dispatcher (not during guided
      dialogues, not for unlinked users); verify the unlinked-user scenario.

## 3. Infra and live verification

- [ ] 3.1 Add the Anthropic API key secret, worker timeout/visibility-timeout changes, and
      config (model id, daily limit, iteration cap) to `infra/lib/bot.ts`; verify
      `infra:build` and `infra:preview`.
- [ ] 3.2 Manual: put the API key in the secret, `infra:up`; in Telegram ask three fixture
      questions (monthly spend, a merchant search, an account balance) and compare the answers
      with direct `data-tools` results; ask the assistant to share an account and confirm;
      check `ai_usage` counts.
- [ ] 3.3 Verify `pnpm exec nx run-many -t lint test build` passes; update
      `docs/architecture.md`.
