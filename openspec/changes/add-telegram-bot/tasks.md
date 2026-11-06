## 1. Decision record

- [x] 1.1 Write `docs/adr/0009-telegram-interface.md`: Telegram bot as the only interface (no web
      app); alternatives (web app/PWA + share target, email forwarding, Gmail API, WhatsApp,
      Signal, Viber, Discord/Slack, upload through Claude via MCP) with trade-offs; Google stays
      the identity via deep-link linking; accepted privacy cost and the retention mitigation.
      Verify it is linked like earlier ADRs.

## 2. Project and shared code

- [x] 2.1 Generate the `bot` Nx project (use the `nx-generate` skill), tags `scope:bot`,
      `type:app`, with esbuild targets per Lambda; add the `scope:bot` rule to
      `eslint.config.mjs`; verify `nx lint bot` passes and a scratch import from `ingestion`
      fails lint (then remove it), covering the `module-boundary-enforcement` scenarios.
- [x] 2.2 Move account creation, membership changes, account listing, and coverage functions
      to `shared/src/lib/accounts/` (design.md decision 4) and switch `ingestion` to them;
      verify ingestion tests pass unchanged.
- [x] 2.3 Add migration `0009-bot` with the tables, policies, and `SECURITY DEFINER`
      functions from design.md decision 3; verify pglite tests: RLS guard test passes;
      a user can't read another user's `messenger_links`/`bot_conversations`; `link_requests`
      isn't directly readable; consume-state succeeds once, fails when reused or expired;
      both `messenger_links` uniqueness rules hold; `statement_outcome_outbox` has RLS with a
      deny-all policy and no direct grants (direct SELECT/INSERT as `draupnir_app` fails),
      `enqueue_outcome` refuses a file the caller didn't upload; `claim_outcome_report`
      returns a row to exactly one of two concurrent callers and re-grants after the lease
      expires; every new `SECURITY DEFINER` function passes the
      search-path guard from `add-row-level-security`.

## 3. Webhook and worker

- [x] 3.1 Implement the webhook handler (constant-time secret check, enqueue to FIFO with group
      = chat id and dedup id = `update_id`, ignore non-private chats); verify every
      `telegram-bot-webhook` scenario with unit tests (mocked SQS).
- [x] 3.2 Implement the Telegram API client and the worker dispatcher (resolve linked `sub`,
      unlinked → sign-in prompt, commands, documents, callback buttons, free text → help);
      verify unit tests for routing and the "unlinked users can only link" scenario.

## 4. Linking

- [x] 4.1 Implement link-request creation, the callback handler (state consume, PKCE code
      exchange, ID token verification, pending link with confirmation code, HTML page showing
      the requesting Telegram account and code), and code redemption by the requesting
      Telegram user (5-minute expiry, 5 attempts); verify tests for every
      `telegram-account-linking` scenario, including the forwarded-link and
      code-from-another-account cases, with a mocked token endpoint and JWKS.
- [x] 4.2 Implement `/unlink`; verify the immediate-effect scenario.

## 5. Upload and outcomes

- [x] 5.1 Implement document handling (CSV check, size check, owner-account check, SEB IBAN
      auto-select, account buttons, 1-hour pending expiry, S3 put at
      `uploads/{sub}/{accountId}/{uuid}.csv`); verify every `telegram-statement-upload`
      acceptance scenario.
- [x] 5.2 Add the transactional outbox (row written in the outcome's transaction, publish after
      commit, sweeper for unpublished rows) and consume outcomes in the bot worker with
      de-duplication by `file_id`; verify the `statement-ingestion-pipeline` outcome scenarios
      (no publish on rollback, recovery after a failed publish) and the report scenarios
      (approved, rejected, delivered twice → reported once, concurrent deliveries → one
      report, crash after claim → reported after lease expiry).

## 6. Account commands

- [x] 6.1 Implement `/accounts`, `/coverage`, and the `/newaccount` dialogue with per-step
      validation, confirm, `/cancel`, and expiry; verify every scenario for those
      requirements in `telegram-account-commands`.
- [x] 6.2 Implement `/share` (Cognito `ListUsers` email lookup) and `/unshare` with
      notifications; verify the share, unknown-email, and last-owner scenarios.

## 7. Retention

- [x] 7.1 Record financial messages in `bot_messages`, delete uploaded documents after the
      outcome reply, and implement the scheduled retention handler (24h, no retries, log
      failures); verify every `telegram-message-retention` scenario with a fake clock.

## 8. Infra and live verification

- [x] 8.1 Add `infra/lib/bot.ts`: webhook route without authorizer, callback route, FIFO and
      outcome queues, Lambdas without VPC, Scheduler rule, worker event source mapping with
      `ReportBatchItemFailures` (the worker returns `batchItemFailures`) and a DLQ, `draupnir-telegram` Cognito app
      client with its own `ManagedLoginBranding` (`useCognitoProvidedValues: true`,
      `dependsOn` the domain, as in `infra/lib/cognito.ts`), secrets (bot token, webhook secret, client secret), IAM (incl.
      `cognito-idp:ListUsers` on the pool); all resources pass `{ provider }`. Add a
      `bot:set-webhook` target. Verify `infra:build` and `infra:preview`.
      Lambda env the code reads: webhook `WEBHOOK_SECRET_ARN`, `BOT_UPDATES_QUEUE_URL`; worker
      `BOT_TOKEN_SECRET_ARN`, `UPLOADS_BUCKET` (worker role needs `s3:PutObject` on `uploads/*`), `COGNITO_BASE_URL`, `TELEGRAM_CLIENT_ID`, `TELEGRAM_CALLBACK_URL`,
      `BOT_USERNAME`, `USER_POOL_ID` (for `/share`), DB vars; callback the same plus `TELEGRAM_CLIENT_SECRET_ARN`,
      `USER_POOL_ID`. The `draupnir-telegram` client needs a client secret.
      Outcome queue: a standard SQS queue (+ DLQ). The ingestion Lambda gets `OUTCOME_QUEUE_URL`
      and `sqs:SendMessage`; the bot worker gets it as a second event source (with
      `ReportBatchItemFailures`) whose **visibility timeout is longer than the 2-minute report
      lease**. The retention Lambda (7.1) also calls `publishDueOutcomes` and `republishUnreportedOutcomes` (outcomes the queue gave up on) on its hourly schedule.
      Retention Lambda env: `BOT_TOKEN_SECRET_ARN`, DB vars, optional `OUTCOME_QUEUE_URL`
      (+ `sqs:SendMessage`); it needs no VPC and no S3/Cognito access. The worker's Telegram client
      also records every sent message, so the worker needs no extra permission for that.
      Status: done. `infra:build`, an offline Pulumi-mock test (`infra/src/bot.spec.ts`), the
      `bot:set-webhook` / `bot:delete-webhook` targets, and a real `nx run infra:preview` (46 to
      create, 8 to update, 1 replace: the migration invocation, expected) all pass.
- [ ] 8.2 Manual: create the bot with BotFather, store the token, `infra:up`, run
      `bot:set-webhook`. Live check with both users' phones (Android and iPhone): link, create
      an account, share it, upload a Revolut CSV from the banking app's share sheet, receive
      the outcome, see the CSV message deleted; after 24h confirm the account list message
      is gone.
      Status: single-user path verified live (bot created, deployed, link, accounts, imports
      for 2 banks). DEFERRED: share/unshare and the second phone/account (access issue).
- [x] 8.3 Verify `pnpm exec nx run-many -t lint test build` passes; update
      `docs/architecture.md`.
- [x] 8.4 Write `docs/telegram-bot.md`: one-time setup runbook (BotFather, secrets, `infra:up`,
      `bot:set-webhook`, rollback with `deleteWebhook`), user guide (linking, every command,
      upload from the share sheet, retention behaviour), and troubleshooting. Link it from
      `docs/architecture.md`.
