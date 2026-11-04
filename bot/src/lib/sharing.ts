import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  executeStatement,
  withCaller,
  type DataApiConfig,
  type MemberRole,
} from 'shared';

export interface Member {
  userId: string;
  role: MemberRole;
}

// Members of an account the caller belongs to (RLS shows nothing otherwise).
export async function listMembers(
  client: RDSDataClient,
  config: DataApiConfig,
  sub: string,
  accountId: string,
): Promise<Member[]> {
  const rows = await withCaller(
    client,
    config,
    sub,
    async (tx) =>
      (
        await executeStatement(
          client,
          config,
          `SELECT user_id, role FROM account_members
            WHERE account_id = :accountId ORDER BY role DESC, user_id`,
          { accountId },
          tx,
        )
      ).rows,
  );
  return (rows as { user_id: string; role: MemberRole }[]).map((r) => ({
    userId: r.user_id,
    role: r.role,
  }));
}

// The Telegram chat of a member of an account the caller owns, or null when
// they are not linked (or not such a member). Look a member up before
// removing them.
export async function memberChatId(
  client: RDSDataClient,
  config: DataApiConfig,
  sub: string,
  accountId: string,
  userId: string,
): Promise<number | null> {
  const rows = await withCaller(
    client,
    config,
    sub,
    async (tx) =>
      (
        await executeStatement(
          client,
          config,
          `SELECT draupnir.telegram_chat_of_member(:accountId, :userId) AS chat`,
          { accountId, userId },
          tx,
        )
      ).rows,
  );
  const chat = (rows[0] as { chat: number | string | null } | undefined)?.chat;
  return chat === null || chat === undefined ? null : Number(chat);
}
