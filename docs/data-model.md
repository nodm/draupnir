# Data model

Reference for every table in the `public` schema and every function in the `draupnir`
schema of the Aurora database. The migrations in `shared/src/lib/migrations/` are the
source of truth; this page explains them. A test (`shared/src/lib/dataModelDoc.spec.ts`)
fails when a table, a column, a column's type or nullability, or a function is added,
removed or changed without this page following, so it cannot silently go stale.

Why the statement tables look this way: [ADR-0008](./adr/0008-statement-data-model.md). How
they are reached: [ADR-0003](./adr/0003-aurora-access-pattern.md) (RDS Data API only).
How the bot uses its tables: [telegram-bot.md](./telegram-bot.md) and
`openspec/changes/add-telegram-bot/design.md`.

## Conventions

- **Ids** are `text` holding a UUID (`gen_random_uuid()::text`), except where a table is keyed
  by something external (an IBAN, a Telegram id, a hash).
- **Users have no table.** A user id (`user_id`, `uploaded_by`, `pending_sub`, ...) is the
  Cognito `sub` as `text`. Email lives in Cognito, except `messenger_links.email`, a copy
  taken at linking time.
- **Money** is an integer count of minor units (cents) in `bigint`, always next to a
  `currency`. `fx_fee_percent` is the only fractional money-like value.
- **Dates** are `date` for bank dates and `timestamptz` for events.
- **Row-level security** is on for every table, and every table has a policy. The
  application role `draupnir_app` owns nothing and has no `BYPASSRLS`. Account-scoped rows
  are visible through membership (`draupnir.is_member(account_id, min_role)`), where the
  caller is `current_setting('app.sub')`, set per transaction by `withCaller`. With no
  caller, every policy returns nothing. Writes need the `owner` role unless a row says
  otherwise.
- **Append-only migrations.** A merged migration is never edited; schema changes are new
  migrations (see the `db-migrations` spec).

## Accounts and access

### `accounts`

One bank account. Created through `draupnir.create_account` (there is no insert policy), so
the creator becomes an owner in the same step. Written by `createAccount` in `shared`.

| Column                        | Type        | Null | Notes                                                     |
| ----------------------------- | ----------- | ---- | --------------------------------------------------------- |
| `id`                          | text        | no   | Primary key.                                              |
| `bank`                        | text        | no   | `seb`, `revolut` or `monobank` (check constraint).        |
| `iban`                        | text        | no   | Unique across all accounts, canonical form (no spaces).   |
| `currency`                    | text        | no   | Account currency, ISO 4217 code.                          |
| `display_name`                | text        | no   | The name the owner gave it, up to 60 characters in chat.  |
| `opened_on`                   | date        | no   | The date `opening_balance_minor_units` is the balance on. |
| `opening_balance_minor_units` | bigint      | no   | Starting point statements are reconciled against.         |
| `created_at`                  | timestamptz | no   | Default `now()`.                                          |

- Access: select for any member; update and delete for owners.

### `account_members`

Who may use an account, and as what. This is the whole authorization model.

| Column       | Type        | Null | Notes                                   |
| ------------ | ----------- | ---- | --------------------------------------- |
| `account_id` | text        | no   | References `accounts(id)`.              |
| `user_id`    | text        | no   | Cognito `sub`.                          |
| `role`       | text        | no   | `owner` or `viewer` (check constraint). |
| `created_at` | timestamptz | no   | Default `now()`.                        |

- Primary key `(account_id, user_id)`; index on `user_id`.
- A trigger (`account_members_keep_last_owner`, before update or delete) refuses to demote or
  remove an account's last owner.
- Access: select for any member; insert, update and delete for owners. Changes go through
  `addMember`, `removeMember` and `changeMemberRole` in `shared`, which lock the rows.

## Statements (three layers)

### `statement_files`

One row per import attempt, approved or rejected.

| Column              | Type        | Null | Notes                                                                                   |
| ------------------- | ----------- | ---- | --------------------------------------------------------------------------------------- |
| `id`                | text        | no   | Primary key.                                                                            |
| `upload_account_id` | text        | no   | The account the uploader chose; references `accounts(id)`. Not always the only account. |
| `uploaded_by`       | text        | no   | Cognito `sub` of the uploader.                                                          |
| `bank`              | text        | no   | The parser used.                                                                        |
| `format_version`    | text        | yes  | Parser format version, for example `seb-v1`; null when none was recognised.             |
| `sha256`            | text        | no   | Hash of the file contents.                                                              |
| `s3_key`            | text        | no   | Object key in the uploads bucket; unique.                                               |
| `status`            | text        | no   | `approved` or `rejected` (check constraint).                                            |
| `rejection_reasons` | jsonb       | yes  | List of `{code, message, row?}` when rejected.                                          |
| `processed_at`      | timestamptz | no   | Wall-clock time, default `clock_timestamp()`.                                           |
| `import_seq`        | bigint      | no   | Identity column in commit order; `rebuildAccount` replays by it.                        |

- Unique `(upload_account_id, sha256)` among approved files: the same file is not imported
  twice.
- Access: a rejected file is visible only to its uploader; an approved file to members of
  the upload account or of any account it resolved to. Insert needs `uploaded_by` = caller
  and ownership of the upload account.
- Written by `processStatementFile` in `ingestion`.

### `statement_file_accounts`

What an approved file did to each account it covered (one file can span accounts).

| Column                        | Type    | Null | Notes                                                |
| ----------------------------- | ------- | ---- | ---------------------------------------------------- |
| `file_id`                     | text    | no   | References `statement_files(id)`.                    |
| `account_id`                  | text    | no   | References `accounts(id)`.                           |
| `declared_from`               | date    | yes  | Period the statement claims to cover.                |
| `declared_to`                 | date    | yes  |                                                      |
| `activity_from`               | date    | yes  | First and last transaction actually present.         |
| `activity_to`                 | date    | yes  |                                                      |
| `opening_balance_minor_units` | bigint  | yes  | Balances stated by the statement, where it has them. |
| `closing_balance_minor_units` | bigint  | yes  |                                                      |
| `new_transaction_count`       | integer | no   | Transactions this file added; default 0.             |
| `warnings`                    | jsonb   | no   | List of `{code, message, row?}`; default `[]`.       |

- Primary key `(file_id, account_id)`; index on `account_id`.
- Source of `/coverage`: periods, gaps and the "reconciled up to" date are computed from it.
- Access: members read; owners insert, but only for a file they may link (`can_link_file`).

### `raw_rows`

Every CSV row as received, so transactions can be re-derived without the original file.

| Column                | Type    | Null | Notes                                                           |
| --------------------- | ------- | ---- | --------------------------------------------------------------- |
| `id`                  | text    | no   | Primary key.                                                    |
| `file_id`             | text    | no   | References `statement_files(id)`.                               |
| `account_id`          | text    | no   | The account this row belongs to.                                |
| `row_number`          | integer | no   | 1-based position in the data rows of the file.                  |
| `bank`                | text    | no   |                                                                 |
| `format_version`      | text    | no   | For example `seb-v1`.                                           |
| `bank_transaction_id` | text    | yes  | The bank's own id, when the format has one (SEB does).          |
| `payload`             | jsonb   | no   | The whole row, header name to string value, exactly as written. |

- Unique `(file_id, row_number)` and `(id, account_id)`; index on `account_id`.
- `(file_id, account_id)` must exist in `statement_file_accounts`; the check is deferred to
  commit because the pipeline writes raw rows first.
- Access: members read; owners write.

### `transactions`

The common, derived, rebuildable layer: what queries and the assistant use.

| Column                        | Type        | Null | Notes                                                                             |
| ----------------------------- | ----------- | ---- | --------------------------------------------------------------------------------- |
| `id`                          | text        | no   | Primary key.                                                                      |
| `account_id`                  | text        | no   | References `accounts(id)`.                                                        |
| `posted_date`                 | date        | no   |                                                                                   |
| `amount_minor_units`          | bigint      | no   | Signed: credits positive, debits negative.                                        |
| `currency`                    | text        | no   |                                                                                   |
| `description`                 | text        | no   | Normalized (trimmed, lower-cased); the original text is in `raw_rows.payload`.    |
| `fee_minor_units`             | bigint      | no   | Default 0.                                                                        |
| `balance_after_minor_units`   | bigint      | yes  | Only when the bank gives a running balance.                                       |
| `dedup_key`                   | text        | no   | `seb:<bank id>` where the bank has an id, otherwise a hash plus occurrence index. |
| `original_currency`           | text        | yes  | Foreign-currency details; set together with `original_amount_minor_units`.        |
| `original_amount_minor_units` | bigint      | yes  |                                                                                   |
| `fx_fee_minor_units`          | bigint      | yes  | Set together with `fx_fee_percent`.                                               |
| `fx_fee_percent`              | numeric     | yes  |                                                                                   |
| `created_at`                  | timestamptz | no   | Default `now()`.                                                                  |

- Unique `(account_id, dedup_key)` (what makes re-imports safe) and `(id, account_id)`.
- Two check constraints keep the foreign-currency and fx-fee pairs both set or both null.
- Access: members read; owners write. Written by `ingestion` (derive) and `rebuildAccount`.

### `transaction_sources`

Which raw row or rows each transaction came from.

| Column           | Type | Null | Notes                                                        |
| ---------------- | ---- | ---- | ------------------------------------------------------------ |
| `transaction_id` | text | no   | With `account_id`, references `transactions`.                |
| `raw_row_id`     | text | no   | With `account_id`, references `raw_rows`.                    |
| `account_id`     | text | no   | Both foreign keys include it, so they cannot cross accounts. |

- Primary key `(transaction_id, raw_row_id)`; index on `raw_row_id`.
- Access: members read; owners write.

## Telegram bot

These are reached by the bot's Lambdas as the linked user (`withCaller`), or, where noted,
only through `SECURITY DEFINER` functions.

### `messenger_links`

Which Telegram account is linked to which Cognito user.

| Column             | Type        | Null | Notes                                             |
| ------------------ | ----------- | ---- | ------------------------------------------------- |
| `telegram_user_id` | bigint      | no   | Unique. In a private chat it is also the chat id. |
| `user_id`          | text        | no   | Cognito `sub`; unique.                            |
| `email`            | text        | no   | Copied from the ID token at link time.            |
| `linked_at`        | timestamptz | no   | Default `now()`.                                  |

- Access: a user reads and deletes only their own row. Rows are created by
  `redeem_link_code`; looked up by Telegram id only through `sub_for_telegram_user`.

### `link_requests`

A pending sign-in: created by `/start`, completed by the confirmation code.

| Column                  | Type        | Null | Notes                                                         |
| ----------------------- | ----------- | ---- | ------------------------------------------------------------- |
| `state_hash`            | text        | no   | Primary key; SHA-256 of the one-time OAuth `state`.           |
| `telegram_user_id`      | bigint      | no   | Unique: one pending request per Telegram account.             |
| `chat_id`               | bigint      | no   |                                                               |
| `telegram_display_name` | text        | no   |                                                               |
| `telegram_username`     | text        | yes  |                                                               |
| `pkce_verifier`         | text        | no   | PKCE verifier for the code exchange.                          |
| `expires_at`            | timestamptz | no   | The sign-in link is valid for 10 minutes.                     |
| `used_at`               | timestamptz | yes  | Set when the callback consumed the state.                     |
| `pending_sub`           | text        | yes  | Who signed in; set by the callback. Links nothing yet.        |
| `pending_email`         | text        | yes  |                                                               |
| `code_hash`             | text        | yes  | SHA-256 of the 6-digit code.                                  |
| `code_expires_at`       | timestamptz | yes  | The code is valid for 5 minutes.                              |
| `code_attempts`         | integer     | no   | Wrong codes so far; the fifth cancels the request. Default 0. |

- Access: none directly (deny-all policy). Only `create_link_request`, `consume_link_state`,
  `set_pending_link`, `redeem_link_code` and `has_pending_link` touch it.

### `bot_conversations`

The one open guided question per user (`/newaccount`, `/share`, `/unshare`).

| Column       | Type        | Null | Notes                                                  |
| ------------ | ----------- | ---- | ------------------------------------------------------ |
| `user_id`    | text        | no   | Primary key: one dialogue per user.                    |
| `kind`       | text        | no   | `newaccount`, `share` or `unshare`.                    |
| `state`      | jsonb       | no   | Step, answers so far, and a nonce binding the buttons. |
| `expires_at` | timestamptz | no   | One hour after the last answer.                        |

- Access: the user's own row.

### `bot_pending_uploads`

A CSV the bot has received, from the choice of account to the outcome report.

| Column                | Type        | Null | Notes                                                                        |
| --------------------- | ----------- | ---- | ---------------------------------------------------------------------------- |
| `id`                  | text        | no   | Primary key; appears in the button data.                                     |
| `user_id`             | text        | no   | Cognito `sub`.                                                               |
| `chat_id`             | bigint      | no   |                                                                              |
| `message_id`          | bigint      | no   | The user's message carrying the file (deleted after the report).             |
| `telegram_file_id`    | text        | no   | To download the file.                                                        |
| `s3_key`              | text        | yes  | Set once an account is chosen; unique. Ties the outcome back to this row.    |
| `expires_at`          | timestamptz | no   | The account choice is valid for one hour.                                    |
| `report_state`        | text        | no   | `pending`, `claimed` or `reported` (check constraint); default `pending`.    |
| `report_claimed_at`   | timestamptz | yes  | Start of the 2-minute report lease.                                          |
| `offered_account_ids` | jsonb       | yes  | The owned accounts shown as buttons; null when one was chosen automatically. |

- Index on `user_id`.
- Access: the user's own rows. The report claim is `claim_outcome_report`.

### `bot_messages`

Every message the bot sent in a linked chat, so retention can delete it.

| Column       | Type        | Null | Notes                                                          |
| ------------ | ----------- | ---- | -------------------------------------------------------------- |
| `chat_id`    | bigint      | no   | Part of the primary key.                                       |
| `message_id` | bigint      | no   | Part of the primary key.                                       |
| `user_id`    | text        | no   | Owner of the chat, taken from the link.                        |
| `sent_at`    | timestamptz | no   | Default `now()`.                                               |
| `deleted_at` | timestamptz | yes  | Set when Telegram deleted it (or it was already gone).         |
| `failed_at`  | timestamptz | yes  | Set when the scheduled run could not delete it; never retried. |
| `claimed_at` | timestamptz | yes  | Lease of the scheduled run working on it (15 minutes).         |

- Partial index on `sent_at` for rows not yet deleted or failed.
- Access: the user's own rows; the retention job uses `record_bot_message`,
  `claim_due_bot_messages`, `mark_bot_message_deleted` and `mark_bot_message_failed`.

### `statement_outcome_outbox`

The transactional outbox: one row per file outcome, written in the same transaction that
commits the file, so a committed outcome is never lost.

| Column         | Type        | Null | Notes                                                   |
| -------------- | ----------- | ---- | ------------------------------------------------------- |
| `file_id`      | text        | no   | Primary key; references `statement_files(id)`.          |
| `s3_key`       | text        | no   | Joins the outcome to `bot_pending_uploads.s3_key`.      |
| `uploaded_by`  | text        | no   | Cognito `sub` of the uploader.                          |
| `payload`      | jsonb       | no   | The outcome message published to the queue.             |
| `created_at`   | timestamptz | no   | Default `now()`.                                        |
| `published_at` | timestamptz | yes  | Set when sent to the queue; refreshed when republished. |

- Access: none directly (deny-all policy). Only `enqueue_outcome`, `due_outcomes`,
  `mark_outcome_published`, `unreported_outcomes` and `recorded_outcome` touch it.

## Functions (`draupnir` schema)

Every `SECURITY DEFINER` function pins `search_path = pg_catalog, pg_temp`, schema-qualifies
what it touches, has `EXECUTE` revoked from `PUBLIC` and granted to `draupnir_app` only. A
guard test enforces that. `current_sub` and `is_member` are the building blocks of the
policies; the rest let a job act where a policy would (rightly) refuse it.

| Function                   | Purpose                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `current_sub`              | The caller (`app.sub`), or null. Not `SECURITY DEFINER`.                                     |
| `is_member`                | True when the caller is a member of an account with at least a role.                         |
| `is_file_member`           | True when the caller is a member of any account an approved file resolved to.                |
| `can_link_file`            | True when the caller owns the file's upload account (required to link the file to accounts). |
| `keep_last_owner`          | Trigger function behind `account_members_keep_last_owner`.                                   |
| `create_account`           | Creates an account and makes the caller its owner, atomically.                               |
| `sub_for_telegram_user`    | Telegram user id to Cognito `sub`, for an incoming update.                                   |
| `create_link_request`      | Starts a sign-in; replaces an earlier one for the same Telegram user.                        |
| `consume_link_state`       | Marks a sign-in `state` as used, once.                                                       |
| `set_pending_link`         | Stores who signed in and the code hash. Links nothing.                                       |
| `redeem_link_code`         | Checks the code from the same Telegram account and creates the link.                         |
| `has_pending_link`         | True when a Telegram user has an unfinished sign-in.                                         |
| `telegram_chat_of_member`  | An owner's lookup of a member's chat, for share and unshare notices.                         |
| `enqueue_outcome`          | Writes the outbox row inside the uploader's import transaction.                              |
| `due_outcomes`             | Outbox rows not published a minute after commit.                                             |
| `mark_outcome_published`   | Sets `published_at`.                                                                         |
| `unreported_outcomes`      | Published outcomes whose upload was never reported (the queue gave up), for republishing.    |
| `recorded_outcome`         | Lets the pipeline recover the outcome it already committed for an S3 key.                    |
| `claim_outcome_report`     | Atomically claims the right to report an outcome (2-minute lease); returns the chat.         |
| `mark_outcome_reported`    | Marks the upload reported.                                                                   |
| `record_bot_message`       | Records a sent message under the owner of that private chat.                                 |
| `claim_due_bot_messages`   | Claims messages older than 24 hours for the retention run (15-minute lease).                 |
| `due_bot_messages`         | Older read-only list of the same; superseded by `claim_due_bot_messages`.                    |
| `mark_bot_message_deleted` | Sets `deleted_at`.                                                                           |
| `mark_bot_message_failed`  | Sets `failed_at`.                                                                            |
