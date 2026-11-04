# ADR-0009: Telegram Bot as the Only Interface

## Status

Accepted

## Date

2026-11-04

## Deciders

Dmytro Novikov

## Context

Draupnir has no user interface. Accounts are created with raw API calls and statements are
uploaded through presigned URLs by hand. Two people use it, one on Android and one on
iPhone. The common action is "export a CSV in the banking app and hand it over", so the
interface must accept a file from the OS share sheet on both platforms. The same surface
should later host the AI assistant (`add-bot-ai-chat`).

Identity already exists: a Cognito user pool with Google federation and a pre-sign-up
allowlist ([ADR-0002](./0002-auth-request-flow.md)). Data access runs as the caller under
row-level security (`add-row-level-security`).

## Decision

A **Telegram bot is the only interface**; there is no web app.

- Telegram is a **linked channel**, not an identity. Google (through the existing Cognito
  pool and allowlist) stays the identity. Linking is a deep-link flow: `/start` returns a
  one-time Cognito sign-in link; after Google sign-in the browser shows a confirmation code
  that must be sent back from the **same Telegram account** that asked. Sign-in alone links
  nothing, so a forwarded link cannot hand someone else's data to the forwarder.
- Architecture: public webhook Lambda (secret header check, enqueue only) → SQS FIFO
  (group = chat id, dedup = `update_id`) → worker Lambda → Telegram API / Aurora as the
  linked `sub`.
- **Privacy mitigation:** Telegram stores chats in its cloud. The uploaded CSV message is
  deleted right after its outcome is reported, and bot messages containing financial data
  are deleted after 24 hours.

## Options Considered

| Option                         | Share sheet (Android + iOS)   | Auth reuse         | Build cost | Privacy of chat content |
| ------------------------------ | ----------------------------- | ------------------ | ---------- | ----------------------- |
| **Telegram bot — chosen**      | Yes, both                     | Linked to Google   | Low        | Cloud-stored, deletable |
| Web app / PWA + share target   | Android only (iOS lacks it)   | Native             | High       | Own storage only        |
| Email forwarding (SES inbound) | Yes, via mail app             | Sender allowlist   | Medium     | Mail providers store it |
| Gmail API polling              | Yes, via mail app             | Google OAuth       | Medium     | Mail providers store it |
| WhatsApp (Business API)        | Yes                           | Phone number       | High       | Business onboarding     |
| Signal                         | Yes                           | None (no bot API)  | n/a        | Best                    |
| Viber                          | Yes                           | Phone number       | Medium     | Cloud-stored            |
| Discord / Slack                | Yes                           | Workspace identity | Medium     | Third-party workspace   |
| Upload through Claude via MCP  | No file path from banking app | Cognito            | Medium     | Claude conversation     |

## Trade-off Analysis

- **Web app / PWA:** iOS Safari has no Web Share Target, so the iPhone user could not share
  from the banking app. It also needs a frontend, hosting, and session handling the bot gets
  free.
- **Email / Gmail API:** works with share sheets but gives no interactive dialogue (account
  choice, confirmations, coverage replies) and adds inbound mail infrastructure or broad
  Gmail scopes.
- **WhatsApp:** Business API onboarding, templates and per-conversation pricing are heavy
  for two users.
- **Signal:** no supported bot API.
- **Viber / Discord / Slack:** no advantage over Telegram for this use case; Discord/Slack
  add a workspace to run.
- **Upload through Claude via MCP:** banking apps hand files to apps through the share sheet,
  not to an MCP client, and MCP has no OAuth discovery yet (ADR-0001/0002 open item).
- **Telegram as identity (Login Widget / Mini App):** rejected; Google sign-in cannot run in
  a Mini App webview, and the allowlist and RLS already hang off the Cognito `sub`.
- **Accepted cost:** financial content transits and is stored in Telegram's cloud for up to
  the retention window, and the chat is not end-to-end encrypted (bots cannot use secret
  chats). The user accepted this residual exposure in exchange for the share-sheet UX on both
  platforms; deletion limits it but does not erase Telegram-side copies or backups.

## Consequences

- New Nx project `bot` (`scope:bot`) that depends on `scope:shared` only; account and
  coverage functions move to `shared`.
- The pipeline publishes each file outcome through a transactional outbox so the chat is
  told exactly once, independent of channel.
- `deleteMessage` only works within 48 hours; a missed deletion is logged and reported, not
  retried.
- A public, unauthenticated-by-Cognito webhook route exists; it is protected by Telegram's
  secret header and never touches the database.
- Rolling back is `deleteWebhook`; ingestion is unaffected.

## Action Items

- [ ] Create the bot with BotFather and store the token (`add-telegram-bot` task 8.2).
- [ ] Revisit the interface decision if a third user without Telegram appears.
