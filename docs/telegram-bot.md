# Telegram bot

The bot is Draupnir's only interface ([ADR-0009](./adr/0009-telegram-interface.md)): you
send it a bank-statement CSV, and it imports it, tells you the result, and answers a few
commands about your accounts. This page has the one-time setup, the user guide, and
troubleshooting. How it is built is in [architecture.md](./architecture.md) and
`openspec/changes/add-telegram-bot/design.md`.

> Status: everything below has been tested offline (unit tests, Pulumi mocks). The live
> check on real phones is task 8.2; until it is done, treat the setup steps as unverified
> and fix this page with whatever the first deploy teaches.

## One-time setup

Needs: the AWS CLI logged in (`aws login`), `pulumi login s3://nodm-pulumi-state/draupnir`
done once (see [infra/README.md](../infra/README.md)), and the existing stack config
(Google client, `allowlistedEmails`, `authDomainPrefix`).

### 1. Create the bot with BotFather

In Telegram, open [@BotFather](https://t.me/BotFather):

1. `/newbot`, then a display name and a username ending in `bot` (this is the `@name`).
2. Copy the token it prints. **Treat it like a password**; anyone with it controls the bot.
3. `/setjoingroups` → Disable. The bot only works in private chats, so keep it out of groups.
4. `/setcommands` → paste:

   ```
   accounts - your accounts
   newaccount - create an account
   coverage - covered periods and gaps
   share - share an account
   unshare - stop sharing an account
   cancel - abandon the current question
   unlink - disconnect this chat
   ```

The token is never put in Pulumi config or in git.

### 2. Tell the stack the bot's name

```bash
cd infra
pulumi config set botUsername "<username without @>"
cd ..
```

Both people who will use the bot must already be in `allowlistedEmails`; otherwise Google
sign-in is refused when they link.

### 3. Deploy

```bash
pnpm exec nx run infra:preview   # read it: queues, 4 Lambdas, an API, a Cognito client
pnpm exec nx run infra:up
```

The first deploy also applies the database migrations `0009`–`0016` (the deploy runs them
before any Lambda is updated, and fails if one fails).

### 4. Store the token

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(cd infra && pulumi stack output botTokenSecretArn)" \
  --secret-string '<token from BotFather>'
```

### 5. Point Telegram at the webhook

```bash
pnpm exec nx run bot:set-webhook
```

It prints the webhook URL and `Pending updates: 0`. A `Last error:` line means Telegram
could not reach it (see troubleshooting). The script sets the secret header and limits
updates to messages and button presses.

### 6. Check it

Send `/start` to the bot. You should get a **Sign in with Google** button.

### Rollback

```bash
pnpm exec nx run bot:delete-webhook
```

The bot stops receiving updates; ingestion, accounts and the database are untouched. Run
`bot:set-webhook` to turn it back on. Messages already in the queues are still handled.

### Changing the token

`/revoke` in BotFather, `put-secret-value` as in step 4, then `bot:set-webhook`. Running
Lambdas keep the old token until their container is replaced; deploying (`infra:up`)
replaces them.

## User guide

Talk to the bot in a **private chat**. Send it anything it does not understand to see the
list of commands.

### Linking your chat (once)

1. Send `/start`. Tap **Sign in with Google** (valid 10 minutes).
2. Sign in with your Google account. The page shows a **6-digit code**.
3. Send that code to the bot **from the same Telegram account** within 5 minutes.
   Five wrong codes cancel the attempt; send `/start` again.

Never share the code. Signing in alone links nothing: the code has to come back from the
Telegram account that asked, so a forwarded sign-in link cannot connect someone else's chat
to your data. `/unlink` disconnects the chat again (you must link again to use the bot).

### Accounts

| Command       | What it does                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `/accounts`   | Lists your accounts: bank, last 4 characters of the IBAN, currency, your role, and the date its history is reconciled up to.     |
| `/newaccount` | Asks bank (buttons), IBAN, currency, name, the date you know the balance, and that balance, then a summary to confirm.           |
| `/coverage`   | Imported periods, gaps, and the "reconciled up to" date for an account (asks which one if you have several).                     |
| `/share`      | Owners only. Pick the account, send the person's Google email, pick **viewer** (read) or **owner**. They are told in their chat. |
| `/unshare`    | Owners only. Pick the account, then the person to remove (you can remove yourself if another owner remains). They are told.      |
| `/cancel`     | Abandons the question the bot is asking. Questions also lapse after an hour with no answer.                                      |

Notes:

- Full IBANs are never printed, only the last four characters.
- An account must keep one owner; removing the last one is refused.
- To change someone's access, `/unshare` then `/share` again.
- If `/newaccount` says the IBAN already exists, ask one of its owners to `/share` it with you.
- `/share` only finds people who have signed in to Draupnir; otherwise it tells you they must
  sign in to Draupnir first.

### Importing a statement

1. In the banking app, export the statement as **CSV**.
2. Share it to Telegram (the share sheet works on Android and iPhone) and pick the bot's
   chat, or attach it in the chat.
3. If the file names exactly one of your accounts (SEB exports do), it is imported straight
   away. Otherwise tap the account it belongs to.
4. The bot says "Importing…", and a moment later reports the result: what was added, the
   period covered, any warnings (for example a gap before the file), or why it was refused.

Limits: CSV only, up to 10 MB, and only an account's **owners** can import. The first reply
after a quiet spell can take up to a minute while the database wakes up.

Importing the same file again is safe: nothing is duplicated.

### What stays in the chat

Telegram keeps chats in its cloud and bots cannot use end-to-end encrypted chats, so the
bot keeps as little as it can:

- Your **CSV message is deleted** right after the bot reports the result (or refuses it).
- **Every message the bot sends is deleted 24 hours later** (within about 30 minutes after
  that; Telegram only allows deleting messages younger than 48 hours).
- Deleting does not erase Telegram's own copies or backups.

If a deletion fails (for example the message was already older than 48 hours), it is
logged and not retried.

## Troubleshooting

Find a function's log group with
`aws lambda list-functions --query "Functions[?starts_with(FunctionName,'bot-')].FunctionName" --output text`,
then `aws logs tail /aws/lambda/<name> --since 1h`.

| Symptom                                      | Likely cause and check                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bot never answers                            | Run `nx run bot:set-webhook` again and read `Last error`. A 401/403 means Telegram's secret header does not match the webhook secret; re-running the script sets the current one.    |
| `set-webhook` says the token secret is empty | Step 4 was not done, or it was stored in another region/stack.                                                                                                                       |
| `/start` works, sign-in page errors          | The Google account is not in `allowlistedEmails`, or the Cognito `draupnir-telegram` client's callback URL does not match `botCallbackUrl` (`pulumi stack output botCallbackUrl`).   |
| "Already linked"                             | That Google or Telegram account is already linked. Send `/unlink` from the linked chat, then link again.                                                                             |
| Upload accepted but no report                | Look at the outcomes queue and its dead-letter queue (`botOutcomesQueueUrl`, `botOutcomesDlqUrl` stack outputs). The scheduled run republishes unreported outcomes hourly for a day. |
| A message seems stuck for minutes            | A failing update is retried 3 times, nine minutes apart, blocking only that chat, then moves to `botUpdatesDlqUrl`.                                                                  |
| First reply is very slow                     | The database was paused; it resumes within about a minute.                                                                                                                           |
| Old bot messages are still in the chat       | Look for `retention-delete-failed` in the retention function's log (it names the chat and message id). Messages older than 48 hours cannot be deleted.                               |

Inspecting a dead-letter queue shows raw Telegram updates, which contain chat content:

```bash
aws sqs receive-message --queue-url "$(cd infra && pulumi stack output botUpdatesDlqUrl)" \
  --max-number-of-messages 5
```

Once the cause is fixed, empty the queue with `aws sqs purge-queue`.
