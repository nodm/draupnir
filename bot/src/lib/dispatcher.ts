import type { CallbackQuery, Document, Message, Update } from '@grammyjs/types';
import type { TelegramClient } from './telegram';

export interface Context {
  update: Update;
  chatId: number;
  telegramUserId: number;
  telegram: TelegramClient;
}

// A user who is linked to a Draupnir identity. Everything past the link check
// acts as `sub`.
export interface LinkedContext extends Context {
  sub: string;
}

export type CommandHandler = (
  ctx: LinkedContext,
  args: string,
) => Promise<void>;

export interface Routes {
  // The linked `sub` for a Telegram user, or null when not linked.
  resolveSub(telegramUserId: number): Promise<string | null>;
  // The only thing an unlinked user can do: link. Receives whatever they sent.
  onUnlinked(ctx: Context): Promise<void>;
  commands: Record<string, CommandHandler>;
  onDocument(
    ctx: LinkedContext,
    message: Message,
    document: Document,
  ): Promise<void>;
  onCallback(
    ctx: LinkedContext,
    query: CallbackQuery,
    data: string,
  ): Promise<void>;
  // Free text. Until the AI chat exists this is the help reply.
  onText(ctx: LinkedContext, text: string): Promise<void>;
}

export const HELP_TEXT = [
  'Send me a CSV statement from your bank and I will import it.',
  '',
  'Commands:',
  '/accounts - your accounts',
  '/newaccount - create an account',
  '/coverage - covered periods and gaps',
  '/share - share an account',
  '/unshare - stop sharing an account',
  '/unlink - disconnect this chat',
].join('\n');

// "/cmd@botname args" -> { name: "cmd", args: "args" }
export function parseCommand(
  text: string,
): { name: string; args: string } | null {
  const match = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  return match
    ? {
        name: (match[1] as string).toLowerCase(),
        args: (match[2] ?? '').trim(),
      }
    : null;
}

// Routes one Telegram update. Updates that are not a private-chat message or
// button press from a user are ignored.
export async function dispatch(
  update: Update,
  telegram: TelegramClient,
  routes: Routes,
): Promise<void> {
  const message = update.message;
  const query = update.callback_query;
  const chat = message?.chat ?? query?.message?.chat;
  const from = message?.from ?? query?.from;
  if (!chat || chat.type !== 'private' || !from || from.is_bot) {
    return;
  }

  const base: Context = {
    update,
    chatId: chat.id,
    telegramUserId: from.id,
    telegram,
  };

  const sub = await routes.resolveSub(from.id);
  if (sub === null) {
    await routes.onUnlinked(base);
    return;
  }
  const ctx: LinkedContext = { ...base, sub };

  if (query) {
    await routes.onCallback(ctx, query, query.data ?? '');
    return;
  }
  if (!message) {
    return;
  }
  if (message.document) {
    await routes.onDocument(ctx, message, message.document);
    return;
  }
  if (message.text !== undefined) {
    const command = parseCommand(message.text);
    if (command) {
      const handler = routes.commands[command.name];
      if (handler) {
        await handler(ctx, command.args);
      } else {
        await telegram.sendMessage(chat.id, HELP_TEXT);
      }
      return;
    }
    await routes.onText(ctx, message.text);
  }
}
