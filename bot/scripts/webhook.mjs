#!/usr/bin/env node
// Points Telegram at the deployed webhook, or removes it again (rollback,
// ADR-0009). Reads the stack outputs with `pulumi` and the secrets with `aws`,
// so it needs both logged in; nothing secret is printed.
//
//   pnpm nx run bot:set-webhook
//   pnpm nx run bot:delete-webhook
import { execFileSync } from 'node:child_process';

const remove = process.argv.includes('--delete');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      ...options,
    }).trim();
  } catch {
    return fail(`\`${command} ${args[0]} ...\` failed (output above).`);
  }
}

const output = (name) =>
  run('pulumi', ['stack', 'output', name], { cwd: 'infra' });
const secret = (arn) =>
  run('aws', [
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    arn,
    '--query',
    'SecretString',
    '--output',
    'text',
  ]);

const token = secret(output('botTokenSecretArn'));
if (!token || token === 'None') {
  fail(
    'The bot token secret is empty. Store the BotFather token first (docs/telegram-bot.md).',
  );
}

// The token is part of the URL, so errors must never print it.
async function telegram(method, params = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    fail(`Telegram ${method} failed: ${body.description ?? response.status}`);
  }
  return body.result;
}

if (remove) {
  await telegram('deleteWebhook', { drop_pending_updates: false });
  console.log('Webhook removed. The bot no longer receives updates.');
} else {
  const url = output('botWebhookUrl');
  await telegram('setWebhook', {
    url,
    secret_token: secret(output('botWebhookSecretArn')),
    allowed_updates: ['message', 'callback_query'],
    max_connections: 10,
  });
  const info = await telegram('getWebhookInfo');
  console.log(`Webhook set: ${info.url}`);
  console.log(`Pending updates: ${info.pending_update_count}`);
  if (info.last_error_message) {
    console.log(`Last error: ${info.last_error_message}`);
  }
}
