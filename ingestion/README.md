# ingestion

This is the ingestion Lambda application (SQS-triggered), scaffolded with [Nx](https://nx.dev).

## Building

Run `nx build ingestion` to bundle the Lambda handler.

## Running unit tests

Run `nx test ingestion` to execute the unit tests via [Vitest](https://vitest.dev).

## Where statements come from

Statements arrive through the Telegram bot (`docs/telegram-bot.md`): the bot
checks that the sender owns the account, refuses files over 10 MiB, and writes
the file to `uploads/{sub}/{accountId}/…` in the uploads bucket. That object
triggers this pipeline through S3 → SQS with no further call. The worker
re-checks the size and the uploader's ownership itself, whoever wrote the
object.
