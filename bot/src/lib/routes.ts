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

export type CallbackRoute = Routes['onCallback'];

export interface RoutesOptions {
  resolveSub: Routes['resolveSub'];
  onUnlinked: Routes['onUnlinked'];
  commands?: Routes['commands'];
  onDocument?: Routes['onDocument'];
  // Button handlers by the prefix before the first ':' in the callback data.
  callbacks?: Record<string, CallbackRoute>;
}

// Handlers that do not exist yet answer honestly instead of failing; later
// tasks (account commands, AI chat) fill them in.
export function createRoutes(options: RoutesOptions): Routes {
  const callbacks = options.callbacks ?? {};
  return {
    resolveSub: options.resolveSub,
    onUnlinked: options.onUnlinked,
    commands: options.commands ?? {},
    onDocument:
      options.onDocument ??
      (async (ctx) => {
        await ctx.telegram.sendMessage(
          ctx.chatId,
          'Statement upload is not available yet.',
        );
      }),
    onCallback: async (ctx, query, data) => {
      // Stops the button's spinner whether or not a handler exists.
      await ctx.telegram.answerCallbackQuery(query.id);
      const prefix = data.split(':')[0] ?? '';
      const route = Object.prototype.hasOwnProperty.call(callbacks, prefix)
        ? callbacks[prefix]
        : undefined;
      if (typeof route === 'function') {
        await route(ctx, query, data);
      }
    },
    onText: async (ctx) => {
      await ctx.telegram.sendMessage(ctx.chatId, HELP_TEXT);
    },
  };
}
