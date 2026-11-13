import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, type DataApiConfig } from 'shared';
import { TelegramApiError, type TelegramClient } from '../telegram';

// Telegram keeps chats in its cloud, so messages carrying financial data are
// recorded in `bot_messages` and deleted again (ADR-0009). Recording and
// deleting never fail the user's request: the data is already in the chat, so
// the point is to not make things worse by crashing.

const log = (event: string, fields: Record<string, unknown>) =>
  console.error(JSON.stringify({ event, ...fields }));

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Telegram says this when the message is already gone (the user deleted it,
// or an earlier run did). The goal is met, so it is not a failure.
export const isAlreadyDeleted = (error: unknown): boolean =>
  error instanceof TelegramApiError &&
  /message to delete not found/i.test(error.message);

export interface Retention {
  // Remembers a message in a linked user's chat for later deletion. Chats with
  // no link record nothing.
  record(chatId: number, messageId: number): Promise<void>;
  // Deletes a message now and updates the record. On failure the record stays,
  // so the scheduled run tries again within its window.
  discard(
    telegram: TelegramClient,
    chatId: number,
    messageId: number,
  ): Promise<void>;
}

export function createRetention(
  client: RDSDataClient,
  config: DataApiConfig,
): Retention {
  const call = (sql: string, chatId: number, messageId: number) =>
    executeStatement(client, config, sql, { chatId, messageId });

  return {
    async record(chatId, messageId) {
      try {
        await call(
          `SELECT draupnir.record_bot_message(CAST(:chatId AS bigint), CAST(:messageId AS bigint))`,
          chatId,
          messageId,
        );
      } catch (error) {
        log('retention-record-failed', {
          chatId,
          messageId,
          error: message(error),
        });
      }
    },

    async discard(telegram, chatId, messageId) {
      try {
        await telegram.deleteMessage(chatId, messageId);
      } catch (error) {
        if (!isAlreadyDeleted(error)) {
          log('retention-discard-failed', {
            chatId,
            messageId,
            error: message(error),
          });
          return;
        }
      }
      await call(
        `SELECT draupnir.mark_bot_message_deleted(CAST(:chatId AS bigint), CAST(:messageId AS bigint))`,
        chatId,
        messageId,
      ).catch((error: unknown) =>
        log('retention-mark-failed', {
          chatId,
          messageId,
          error: message(error),
        }),
      );
    },
  };
}

// Every message the bot sends is recorded, so whatever it says about accounts
// or transactions is covered without each command having to remember to.
export function withRetention(
  telegram: TelegramClient,
  retention: Retention,
): TelegramClient {
  return {
    ...telegram,
    async sendMessage(chatId, text, options) {
      const sent = await telegram.sendMessage(chatId, text, options);
      await retention.record(chatId, sent.message_id);
      return sent;
    },
  };
}

const BATCH = 100;
const MAX_BATCHES = 20;

export interface SweepResult {
  deleted: number;
  failed: number;
}

// Deletes every recorded message older than 20 hours. Messages are claimed
// (with a lease) as they are fetched, so overlapping runs never work on the
// same one. One try each: a message
// that cannot be deleted (typically past Telegram's 48-hour limit) is marked
// failed and logged with its chat and message id, never retried.
export async function sweepRetention(
  telegram: TelegramClient,
  client: RDSDataClient,
  config: DataApiConfig,
): Promise<SweepResult> {
  const result: SweepResult = { deleted: 0, failed: 0 };

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { rows } = await executeStatement(
      client,
      config,
      `SELECT chat_id, message_id FROM draupnir.claim_due_bot_messages(CAST(:limit AS integer))`,
      { limit: BATCH },
    );
    const due = rows as { chat_id: number; message_id: number }[];

    for (const { chat_id: chatId, message_id: messageId } of due) {
      const params = { chatId, messageId };
      try {
        await telegram.deleteMessage(chatId, messageId);
        result.deleted++;
      } catch (error) {
        if (isAlreadyDeleted(error)) {
          result.deleted++;
        } else {
          result.failed++;
          log('retention-delete-failed', {
            chatId,
            messageId,
            error: message(error),
          });
          await executeStatement(
            client,
            config,
            `SELECT draupnir.mark_bot_message_failed(CAST(:chatId AS bigint), CAST(:messageId AS bigint))`,
            params,
          );
          continue;
        }
      }
      await executeStatement(
        client,
        config,
        `SELECT draupnir.mark_bot_message_deleted(CAST(:chatId AS bigint), CAST(:messageId AS bigint))`,
        params,
      );
    }
    if (due.length < BATCH) break;
  }
  return result;
}
