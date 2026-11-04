import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, withCaller, type DataApiConfig } from 'shared';
import type { CommandHandler } from '../dispatcher';

// Runs as the caller: the messenger_links DELETE policy only matches their own
// row. The link is read fresh on every update, so the very next message is
// treated as coming from an unlinked user.
export function createUnlinkHandler(
  client: RDSDataClient,
  config: DataApiConfig,
): CommandHandler {
  return async (ctx) => {
    await withCaller(client, config, ctx.sub, (transactionId) =>
      executeStatement(
        client,
        config,
        `DELETE FROM messenger_links WHERE telegram_user_id = CAST(:telegramUserId AS bigint)`,
        { telegramUserId: ctx.telegramUserId },
        transactionId,
      ),
    );
    await ctx.telegram.sendMessage(
      ctx.chatId,
      'Unlinked. This chat no longer has access to your data. Send /start to link again.',
    );
  };
}
