## Context

Display name lives in `accounts.display_name`. `/newaccount` validates it (≤60 chars)
in `bot/src/lib/commands/newAccount.ts`. `/share` already has the pattern needed:
owned-account list, nonce-bound buttons, conversation store with 1h expiry, free-text
step (`share.ts`). Migration 0005 gives the app role `UPDATE` on `accounts` with an
owner-only RLS policy.

## Goals / Non-Goals

**Goals:** owner renames an account from the bot, smallest working version.
**Non-Goals:** per-user nicknames, rename by viewers,
renaming via MCP, per-user nicknames for viewers, editing other fields (bank, IBAN, currency).

## Decisions

- **Owner-only, shared name.** "Their own accounts" = accounts they own. A per-user
  alias would need a new table and touch every listing; deferred.
- **No migration.** Existing `accounts_update` RLS policy enforces owner-only. The
  `shared` helper runs `UPDATE accounts SET display_name = :name WHERE id = :id` inside
  `withCaller`; zero rows updated ⇒ `NotAccountOwnerError` (same error class as sharing).
  Alternative (SECURITY DEFINER function like `create_account`) rejected: not needed,
  RLS already narrows rows.
- **Own dialogue, same plumbing as `/share`:** conversation kind `rename`, steps
  `account` → `name`, callback prefix `ra`, nonce on buttons. Single owned account skips
  `account` step.
- **Validation in `shared`** (trim, 1–60) so bot and any future caller agree; bot shows
  the friendly message. Reuse the 60 limit as a shared constant instead of the literal in
  `newAccount.ts`.
- **No confirm step (decided):** trivially reversible; reply shows old → new.
- **Notify other members (decided):** reuse `/share`'s `notify` pattern with
  `listMembers` + `memberChatId` from `sharing.ts`; skip the caller; best-effort, never
  fails the rename. Extract `notify`/`whoIs` from `share.ts` into a shared bot helper
  rather than duplicating.

## Risks / Trade-offs

- Viewers see a name they did not choose change → they are notified; acceptable.
- Free-text routing: the text handler must route to the rename dialogue the same way
  `handleSharingText` does; missing this makes the name be treated as unknown text.
