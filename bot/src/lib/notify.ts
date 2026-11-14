import type { UserDirectory } from './directory';
import type { LinkedContext } from './dispatcher';

export async function whoIs(
  ctx: LinkedContext,
  directory: UserDirectory,
): Promise<string> {
  return (await directory.emailOf(ctx.sub).catch(() => null)) ?? 'An owner';
}

export type Tell = 'sent' | 'unlinked' | 'failed';

// Tells a member in their own chat. Never throws: the change is already made.
export async function tell(
  ctx: LinkedContext,
  chat: number | null,
  text: string,
): Promise<Tell> {
  if (chat === null) return 'unlinked';
  try {
    await ctx.telegram.sendMessage(chat, text);
    return 'sent';
  } catch {
    return 'failed';
  }
}

// Same, as a note for the owner when nobody was told.
export async function notify(
  ctx: LinkedContext,
  chat: number | null,
  text: string,
): Promise<string> {
  switch (await tell(ctx, chat, text)) {
    case 'unlinked':
      return ' They are not linked to Telegram, so nobody was notified.';
    case 'failed':
      return ' They could not be notified in Telegram.';
    default:
      return ' They were notified.';
  }
}
