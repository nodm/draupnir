## Context

See proposal.md for motivation. Today `state` is `randomToken()` (32 random bytes, base64url), stored as `sha256Hex(state)` in `link_requests.state_hash` (`text PRIMARY KEY`). `consume_link_state` marks it used while unused and unexpired (DB `expires_at`). The worker (`handleUnlinked`) issues links; `bot-callback` (public, no authorizer) consumes them. Both Lambdas already read Secrets Manager through `getSecretString` (cached per cold start).

## Goals / Non-Goals

**Goals:**
- Reject forged, tampered, expired and old-format state in the callback with zero Data API, Cognito or Telegram calls.
- Keep single-use and the DB expiry as the authoritative second line.

**Non-Goals:**
- Replacing the 6-digit code, PKCE, or the Cognito client.
- Rate limiting the public route (API Gateway throttling already exists).
- Secret rotation tooling.

## Decisions

**Token format.** `base64url(payload) + "." + base64url(mac)`.
- `payload` = 16 random bytes nonce ‖ 6-byte big-endian expiry in epoch seconds (22 bytes → 30 chars). 6 bytes avoids the uint32 year-2106 limit at no real cost.
- `mac` = HMAC-SHA256(secret, payload bytes) → 43 chars. Total 74 chars; fine for a URL and Telegram button.
- Alternative: JWT. Rejected: extra dependency, header/alg surface, bigger. Alternative: truncated MAC. Rejected: saves little, weakens.
- The MAC covers the raw payload bytes, so it does not pin the string: Node ignores the unused low bits of the last base64url character (22 bytes → 30 chars, 32 bytes → 43 chars), so other spellings of the same bytes pass the signature check. The database hashes the full string, so a variant would not be a replay, but it would get past the cheap check and reach the database. `verifyState` therefore requires each part to be canonical: `Buffer.from(part, 'base64url').toString('base64url') === part`, else reject. Plus a charset check and exact lengths.

**New module `bot/src/lib/linking/state.ts`.** `signState(secret, now, ttlMs)` and `verifyState(secret, state, now)` → `boolean`. `now` injectable (matches `UnlinkedDeps.now`). Compare with `crypto.timingSafeEqual` after a length check. Cap input length (reject > 256 chars) before decoding. `verifyState` never throws.

**Expiry.** `exp = floor((now + LINK_REQUEST_TTL_MS)/1000)`, the same instant as the DB `expiresAt`. Rejected when `nowSeconds > exp`. The DB check stays authoritative; the token check is only the cheap pre-filter.

**Secret.** `bot-link-state-secret`: `random.RandomPassword` (length 48, `special: false`) + `aws.secretsmanager.Secret` + `SecretVersion`, copied from `bot-webhook-secret`. `readSecrets(...)` added for worker and callback; env `LINK_STATE_SECRET_ARN` on both. The webhook, retention and other Lambdas do not get it.

**Wiring.** `UnlinkedDeps` and `CallbackDeps` gain `stateSecret: string`, passed in from the handlers after `getSecretString`. Keeps `linking.spec.ts` free of Secrets Manager; tests pass a fixed secret.

**Callback order** in `handleLinkCallback`: (1) `error`/missing → `FAILED_PAGE` 400; (2) `verifyState` false → `EXPIRED_PAGE` 400; (3) `consumeState(sha256Hex(state))` as before. The callback handler reads the link-state secret first, runs the `error`/missing/signature/expiry checks, and only then loads the bot token and Cognito client secret, so forged requests on a cold start cost one cached Secrets Manager read and nothing else. To keep `handleLinkCallback` testable, the remaining deps are built lazily after the check passes (e.g. `exchangeCode` and `notify` resolve their secret on first use).

**No migration.** `state_hash` stores `sha256Hex(<full state string>)`, an opaque `text` key; the stored value and the `create_link_request` / `consume_link_state` / `set_pending_link` signatures are unchanged, only the string being hashed is longer and signed. `createRequest` and `setPending` keep receiving `sha256Hex(state)`. Pre-deploy rows have unguessable hashes of old-format strings that no longer pass step 2; they expire in ≤10 minutes and are replaced by the per-user upsert. Confirm during apply that no migration test or function body assumes a 43-char state.

## Risks / Trade-offs

- [Secret rotation invalidates in-flight links] → Links live 10 minutes; users send `/start` again. Document.
- [Worker and callback deployed out of step] → Single Pulumi update; worst case is `EXPIRED_PAGE` for links issued in the gap, within 10 minutes.
- [Clock skew between Lambdas] → Both use AWS time; the check only rejects early-expired tokens and the DB still decides.
- [Secret missing at cold start] → `getSecretString` throws and the Lambda errors (fail closed), same as the other secrets.

- [A valid token can be replayed against the database until it expires] After first use a token still passes the signature and expiry check, so each replay costs one Data API call (which finds it used) for up to 10 minutes. Only someone holding a real link can do this, and since #67 links go only to allowlisted senders. Accepted.

## Migration Plan

1. `pnpm exec nx run infra:up` creates the secret and updates both Lambdas together.
2. Links issued before the deploy show the expired page; send `/start` again.
3. Rollback: revert and redeploy; the database row stores `sha256(state)` of the full string, which the old code also hashes, so new-format links still resolve and keep working. Rollback breaks nothing.
