## 1. State token

- [x] 1.1 Add `bot/src/lib/linking/state.ts` with `signState` / `verifyState` (nonce + 6-byte expiry, HMAC-SHA256, `timingSafeEqual`, strict decode, length cap, never throws); verify with unit tests in `linking.spec.ts`: round trip passes, length ≤ 80 chars, different calls differ
- [x] 1.2 Tests reject tampered payload, tampered signature, expired, garbage (empty, no dot, extra dots, non-base64url, oversized), wrong secret, old 43-char random token, and a one-character change in the last position of each part (non-canonical base64url) rejected; verify `pnpm exec nx run bot:test` passes

## 2. Wire issue and verify

- [x] 2.1 `unlinked.ts`: add `stateSecret` to `UnlinkedDeps`, issue `signState(...)` instead of `randomToken()` with expiry from the same `now` and `LINK_REQUEST_TTL_MS` as `expiresAt`; keep `stateHash: sha256Hex(state)`; update `requestLink` and other `handleUnlinked` calls in `linking.spec.ts`; verify the existing "sign-in link" and "successful link" tests pass
- [x] 2.2 `callback.ts`: add `stateSecret` to `CallbackDeps`; order = error/missing → `FAILED_PAGE`, then `verifyState` → `EXPIRED_PAGE`, then `consumeState`; verify with mock-store tests that tampered/garbage/expired/wrong-secret/old-format states leave `store` methods, `exchangeCode`, `verifyIdToken` and `notify` uncalled, and error/missing params do the same
- [x] 2.3 Verify a valid state still passes, is single-use (second call → `EXPIRED_PAGE`, `exchangeCode` once), and the DB-expiry test ("older than 10 minutes") still passes
- [x] 2.4 `bot/src/callback.ts` and `bot/src/worker.ts`: read `LINK_STATE_SECRET_ARN` with `getSecretString` and pass it in; in `callback.ts` handler load the bot token and client secret lazily, only after the state check passes (test: forged state makes no bot-token/client-secret read); verify `pnpm exec tsc --noEmit` in `bot` and `pnpm exec nx run bot:test` pass

## 3. Infra

- [x] 3.1 `infra/lib/bot.ts`: add `bot-link-state-secret` (`RandomPassword` length 48, `special: false`, Secret, SecretVersion), add to `readSecrets` for worker and callback, set `LINK_STATE_SECRET_ARN` env on those two only; verify `pnpm exec nx run infra:preview` shows the new secret and only the worker and callback Lambdas changing
- [x] 3.2 Confirm no migration is needed: grep `shared/src/lib/migrations/0009-bot.ts` and tests for any length or format assumption on `state_hash`; note the result in design.md if anything differs

## 4. Docs and spec

- [x] 4.1 `docs/telegram-bot.md`: linking section says the link is signed and checked before anything else, add a troubleshooting row ("sign-in page says expired right after tapping" → issued before a deploy or secret rotation, send `/start`), and a one-line rotation note; `docs/architecture.md`: add the secret node and read edges for worker and callback; verify the Mermaid diagram still renders (lint/format passes)
- [x] 4.2 Run `pnpm exec openspec validate sign-telegram-link-state` and verify it passes
- [x] 4.3 Lint/format and verify `pnpm exec nx affected -t lint test build` is green

## 5. Rollout

- [x] 5.1 After `infra:up`, hit the callback with a forged state (`curl "<botCallbackUrl>?code=x&state=forged"`) and verify the expired page and no Data API activity in the callback log; existing links are unaffected (both accounts already linked, no relink needed; a full link round trip is covered by tests and only needs `/unlink` + `/start` if you want it live)
