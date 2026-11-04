import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, type DataApiConfig } from 'shared';
import { HELP_TEXT, type Routes } from './dispatcher';

// The Telegram id -> sub lookup runs before any identity exists, so it goes
// through the SECURITY DEFINER function instead of RLS.
export function createSubResolver(
  client: RDSDataClient,
  config: DataApiConfig,
): Routes['resolveSub'] {
  return async (telegramUserId) => {
    const { rows } = await executeStatement(
      client,
      config,
      `SELECT draupnir.sub_for_telegram_user(CAST(:id AS bigint)) AS sub`,
      { id: telegramUserId },
    );
    const sub = (rows[0] as { sub: string | null } | undefined)?.sub;
    return sub ?? null;
  };
}

// Handlers for linking, documents, buttons and commands are added by their own
// tasks (sections 4-6); until then they answer honestly instead of failing.
export function createRoutes(
  resolveSub: Routes['resolveSub'],
  onUnlinked: Routes['onUnlinked'],
  commands: Routes['commands'] = {},
): Routes {
  return {
    resolveSub,
    onUnlinked,
    commands,
    onDocument: async (ctx) => {
      await ctx.telegram.sendMessage(
        ctx.chatId,
        'Statement upload is not available yet.',
      );
    },
    onCallback: async (ctx, query) => {
      await ctx.telegram.answerCallbackQuery(query.id);
    },
    onText: async (ctx) => {
      await ctx.telegram.sendMessage(ctx.chatId, HELP_TEXT);
    },
  };
}
