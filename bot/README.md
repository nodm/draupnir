# bot

Telegram bot Lambdas (webhook, SQS worker, Google sign-in callback, retention job),
scaffolded with [Nx](https://nx.dev). See `openspec/changes/archive/2026-11-07-add-telegram-bot` and
[ADR-0009](../docs/adr/0009-telegram-interface.md).

## Building

Run `nx build bot` to bundle the Lambda handlers.

## Running unit tests

Run `nx test bot` to execute the unit tests via [Vitest](https://vitest.dev).
