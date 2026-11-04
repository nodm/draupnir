import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, withCaller, type DataApiConfig } from 'shared';

export const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;

export interface PendingUpload {
  id: string;
  chatId: number;
  messageId: number;
  telegramFileId: string;
  offeredAccountIds: string[];
}

export interface PendingUploads {
  // `offered` null = the account is already chosen (auto-selected SEB file).
  create(input: {
    chatId: number;
    messageId: number;
    telegramFileId: string;
    offeredAccountIds: string[] | null;
    s3Key: string | null;
    now?: Date;
  }): Promise<string>;
  // An unexpired upload still waiting for an account choice.
  get(id: string, now?: Date): Promise<PendingUpload | null>;
  // Atomically takes an unexpired, not-yet-chosen upload and binds it to its
  // S3 key. Only one of two simultaneous button presses gets it.
  claim(id: string, s3Key: string, now?: Date): Promise<PendingUpload | null>;
  discard(id: string): Promise<void>;
}

interface PendingRow {
  id: string;
  chat_id: number;
  message_id: number;
  telegram_file_id: string;
  offered_account_ids: string[] | string | null;
}

function toPending(row: PendingRow): PendingUpload {
  const offered = row.offered_account_ids;
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    telegramFileId: row.telegram_file_id,
    offeredAccountIds:
      typeof offered === 'string'
        ? (JSON.parse(offered) as string[])
        : (offered ?? []),
  };
}

export function createPendingUploads(
  client: RDSDataClient,
  config: DataApiConfig,
  sub: string,
): PendingUploads {
  const inCaller = <T>(fn: (tx: string) => Promise<T>) =>
    withCaller(client, config, sub, fn);

  return {
    create: (input) =>
      inCaller(async (tx) => {
        const { rows } = await executeStatement(
          client,
          config,
          `INSERT INTO bot_pending_uploads
             (user_id, chat_id, message_id, telegram_file_id, offered_account_ids, s3_key, expires_at)
           VALUES (:sub, CAST(:chatId AS bigint), CAST(:messageId AS bigint), :fileId,
                   CAST(:offered AS jsonb), :s3Key, CAST(:expiresAt AS timestamptz))
           RETURNING id`,
          {
            sub,
            chatId: input.chatId,
            messageId: input.messageId,
            fileId: input.telegramFileId,
            offered:
              input.offeredAccountIds === null
                ? null
                : JSON.stringify(input.offeredAccountIds),
            s3Key: input.s3Key,
            expiresAt: new Date(
              (input.now ?? new Date()).getTime() + PENDING_UPLOAD_TTL_MS,
            ).toISOString(),
          },
          tx,
        );
        return (rows[0] as { id: string }).id;
      }),

    get: (id, now = new Date()) =>
      inCaller(async (tx) => {
        const { rows } = await executeStatement(
          client,
          config,
          `SELECT id, chat_id, message_id, telegram_file_id, offered_account_ids
             FROM bot_pending_uploads
            WHERE id = :id AND s3_key IS NULL AND expires_at > CAST(:now AS timestamptz)`,
          { id, now: now.toISOString() },
          tx,
        );
        return rows[0] ? toPending(rows[0] as unknown as PendingRow) : null;
      }),

    claim: (id, s3Key, now = new Date()) =>
      inCaller(async (tx) => {
        const { rows } = await executeStatement(
          client,
          config,
          `UPDATE bot_pending_uploads SET s3_key = :s3Key
            WHERE id = :id AND s3_key IS NULL AND expires_at > CAST(:now AS timestamptz)
          RETURNING id, chat_id, message_id, telegram_file_id, offered_account_ids`,
          { id, s3Key, now: now.toISOString() },
          tx,
        );
        return rows[0] ? toPending(rows[0] as unknown as PendingRow) : null;
      }),

    discard: (id) =>
      inCaller(async (tx) => {
        await executeStatement(
          client,
          config,
          `DELETE FROM bot_pending_uploads WHERE id = :id`,
          { id },
          tx,
        );
      }),
  };
}
