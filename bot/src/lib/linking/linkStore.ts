import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, type DataApiConfig } from 'shared';

// Every call goes through a SECURITY DEFINER function: linking happens before
// any identity exists, and link_requests has no direct grants (migration 0009).

export interface NewLinkRequest {
  stateHash: string;
  telegramUserId: number;
  chatId: number;
  displayName: string;
  username: string | null;
  pkceVerifier: string;
  expiresAt: Date;
}

export interface ConsumedLinkRequest {
  telegramUserId: number;
  chatId: number;
  displayName: string;
  username: string | null;
  pkceVerifier: string;
}

export type SetPendingResult =
  | 'ok'
  | 'invalid'
  | 'sub_already_linked'
  | 'telegram_already_linked';

export type RedeemStatus =
  | 'linked'
  | 'wrong'
  | 'cancelled'
  | 'expired'
  | 'already_linked'
  | 'none';

export interface LinkStore {
  createRequest(request: NewLinkRequest): Promise<void>;
  consumeState(stateHash: string): Promise<ConsumedLinkRequest | null>;
  setPending(
    stateHash: string,
    sub: string,
    email: string,
    codeHash: string,
  ): Promise<SetPendingResult>;
  redeem(
    telegramUserId: number,
    codeHash: string,
  ): Promise<{ status: RedeemStatus; email: string | null }>;
  hasPending(telegramUserId: number): Promise<boolean>;
}

export function createLinkStore(
  client: RDSDataClient,
  config: DataApiConfig,
): LinkStore {
  const run = (
    sql: string,
    parameters: Parameters<typeof executeStatement>[3],
  ) => executeStatement(client, config, sql, parameters).then((r) => r.rows);

  return {
    async createRequest(r) {
      await run(
        `SELECT draupnir.create_link_request(:stateHash, CAST(:telegramUserId AS bigint), CAST(:chatId AS bigint), :displayName, :username, :pkceVerifier, CAST(:expiresAt AS timestamptz))`,
        {
          stateHash: r.stateHash,
          telegramUserId: r.telegramUserId,
          chatId: r.chatId,
          displayName: r.displayName,
          username: r.username,
          pkceVerifier: r.pkceVerifier,
          expiresAt: r.expiresAt.toISOString(),
        },
      );
    },

    async consumeState(stateHash) {
      const rows = await run(
        `SELECT * FROM draupnir.consume_link_state(:stateHash)`,
        { stateHash },
      );
      const row = rows[0] as
        | {
            telegram_user_id: number;
            chat_id: number;
            display_name: string;
            username: string | null;
            pkce_verifier: string;
          }
        | undefined;
      return row
        ? {
            telegramUserId: row.telegram_user_id,
            chatId: row.chat_id,
            displayName: row.display_name,
            username: row.username,
            pkceVerifier: row.pkce_verifier,
          }
        : null;
    },

    async setPending(stateHash, sub, email, codeHash) {
      const rows = await run(
        `SELECT draupnir.set_pending_link(:stateHash, :sub, :email, :codeHash) AS result`,
        { stateHash, sub, email, codeHash },
      );
      return (rows[0] as { result: SetPendingResult }).result;
    },

    async redeem(telegramUserId, codeHash) {
      const rows = await run(
        `SELECT * FROM draupnir.redeem_link_code(CAST(:telegramUserId AS bigint), :codeHash)`,
        { telegramUserId, codeHash },
      );
      const row = rows[0] as {
        status: RedeemStatus;
        linked_email: string | null;
      };
      return { status: row.status, email: row.linked_email };
    },

    async hasPending(telegramUserId) {
      const rows = await run(
        `SELECT draupnir.has_pending_link(CAST(:telegramUserId AS bigint)) AS pending`,
        { telegramUserId },
      );
      return (rows[0] as { pending: boolean }).pending;
    },
  };
}
