import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { Update } from '@grammyjs/types';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export interface QueuedUpdate {
  // FIFO ordering key: all updates of one chat are processed in order.
  groupId: string;
  // FIFO dedup key: Telegram retries carry the same update_id.
  dedupId: string;
  body: string;
}

export interface WebhookDeps {
  secret: string;
  enqueue(update: QueuedUpdate): Promise<void>;
}

// Hashing first makes both inputs the same length, so neither the comparison
// time nor an early length check reveals anything about the secret.
export function secretMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided ?? ''), digest(expected));
}

function header(
  headers: APIGatewayProxyEvent['headers'],
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

// The chat an update belongs to, for the kinds of update the bot handles.
export function chatOfUpdate(
  update: Update,
): { id: number; type: string } | undefined {
  return update.message?.chat ?? update.callback_query?.message?.chat;
}

const ok = (): APIGatewayProxyResult => ({ statusCode: 200, body: '' });

export async function handleWebhook(
  event: APIGatewayProxyEvent,
  deps: WebhookDeps,
): Promise<APIGatewayProxyResult> {
  // Checked before the body is parsed or queued.
  if (!secretMatches(header(event.headers, SECRET_HEADER), deps.secret)) {
    return { statusCode: 401, body: '' };
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  let update: Update;
  try {
    update = JSON.parse(body) as Update;
  } catch {
    return { statusCode: 400, body: '' };
  }
  if (typeof update?.update_id !== 'number') {
    return { statusCode: 400, body: '' };
  }

  // Private chats only. Anything else is acknowledged (so Telegram does not
  // retry it) and dropped.
  const chat = chatOfUpdate(update);
  if (!chat || chat.type !== 'private') {
    return ok();
  }

  await deps.enqueue({
    groupId: String(chat.id),
    dedupId: String(update.update_id),
    body,
  });
  return ok();
}
