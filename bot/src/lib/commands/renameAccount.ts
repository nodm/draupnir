import { randomBytes } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { CallbackQuery } from '@grammyjs/types';
import {
  InvalidAccountInputError,
  MAX_DISPLAY_NAME_LENGTH,
  NotAccountOwnerError,
  renameAccount,
  type DataApiConfig,
} from 'shared';
import { accountLabel } from '../accounts/format';
import { createConversationStore } from '../conversations';
import type { UserDirectory } from '../directory';
import type { CommandHandler, LinkedContext } from '../dispatcher';
import { listMemberAccounts, type MemberAccount } from '../memberAccounts';
import { tell, whoIs, type Tell } from '../notify';
import { listMembers, memberChatId } from '../sharing';

export const RENAME_KIND = 'rename';
export const RENAME_ACCOUNT_PREFIX = 'ra';

export interface RenameDeps {
  client: RDSDataClient;
  config: DataApiConfig;
  directory: UserDirectory;
}

// `nonce` ties buttons to this dialogue; buttons of an earlier one are refused.
interface RenameState {
  nonce: string;
  step: 'account' | 'name';
  accountId?: string;
}

const store = (deps: RenameDeps, sub: string) =>
  createConversationStore(deps.client, deps.config, sub);

const CANCEL_HINT = 'Send /cancel to stop.';
const EXPIRED = 'That request has expired. Send /renameaccount to start again.';
const NOT_OWNER =
  'You are not an owner of that account any more, so nothing was renamed.';

async function ownedAccounts(
  ctx: LinkedContext,
  deps: RenameDeps,
): Promise<MemberAccount[]> {
  return (await listMemberAccounts(deps.client, deps.config, ctx.sub)).filter(
    (a) => a.role === 'owner',
  );
}

const askName = (ctx: LinkedContext, account: MemberAccount) =>
  ctx.telegram.sendMessage(
    ctx.chatId,
    `Rename ${accountLabel(account)}. What should its new name be (up to ${MAX_DISPLAY_NAME_LENGTH} characters)? ${CANCEL_HINT}`,
  );

export function createRenameHandler(deps: RenameDeps): CommandHandler {
  return async (ctx) => {
    const accounts = await ownedAccounts(ctx, deps);
    if (accounts.length === 0) {
      await ctx.telegram.sendMessage(
        ctx.chatId,
        'You do not own any account. Only an owner can rename an account.',
      );
      return;
    }
    const nonce = randomBytes(4).toString('hex');
    const only = accounts.length === 1 ? accounts[0] : undefined;
    await store(deps, ctx.sub).set<RenameState>(RENAME_KIND, {
      nonce,
      step: only ? 'name' : 'account',
      accountId: only?.id,
    });
    if (only) {
      await askName(ctx, only);
      return;
    }
    await ctx.telegram.sendMessage(
      ctx.chatId,
      'Which account do you want to rename?',
      {
        replyMarkup: {
          inline_keyboard: accounts.map((a) => [
            {
              text: accountLabel(a),
              callback_data: `${RENAME_ACCOUNT_PREFIX}:${nonce}:${a.id}`,
            },
          ]),
        },
      },
    );
  };
}

// Tells every other member who is linked. Best-effort: the rename is done.
async function notifyMembers(
  ctx: LinkedContext,
  deps: RenameDeps,
  accountId: string,
  oldName: string,
  newName: string,
): Promise<string> {
  let members;
  try {
    members = (
      await listMembers(deps.client, deps.config, ctx.sub, accountId)
    ).filter((m) => m.userId !== ctx.sub);
  } catch {
    return ' Other members could not be notified (member lookup failed).';
  }
  if (members.length === 0) return '';
  const text = `${await whoIs(ctx, deps.directory)} renamed the account "${oldName}" to "${newName}".`;
  const results: Tell[] = [];
  for (const member of members) {
    const chat = await memberChatId(
      deps.client,
      deps.config,
      ctx.sub,
      accountId,
      member.userId,
    ).catch(() => null);
    results.push(await tell(ctx, chat, text));
  }
  const sent = results.filter((r) => r === 'sent').length;
  if (sent === results.length) return ' Other members were notified.';
  if (sent === 0) return ' Nobody else could be notified in Telegram.';
  return ` ${sent} of ${results.length} other members were notified.`;
}

async function complete(
  ctx: LinkedContext,
  state: RenameState,
  text: string,
  deps: RenameDeps,
): Promise<void> {
  const { telegram, chatId } = ctx;
  const accountId = state.accountId as string;
  try {
    const { oldName, newName } = await renameAccount(
      deps.client,
      deps.config,
      ctx.sub,
      { accountId, displayName: text },
    );
    await store(deps, ctx.sub).clear();
    const note = await notifyMembers(ctx, deps, accountId, oldName, newName);
    await telegram.sendMessage(
      chatId,
      `Renamed "${oldName}" to "${newName}".${note}`,
    );
  } catch (error) {
    if (error instanceof InvalidAccountInputError) {
      // An attempt is activity: writing the state back restarts the expiry.
      await store(deps, ctx.sub).set<RenameState>(RENAME_KIND, state);
      await telegram.sendMessage(
        chatId,
        `Give the account a name of up to ${MAX_DISPLAY_NAME_LENGTH} characters. ${CANCEL_HINT}`,
      );
      return;
    }
    if (error instanceof NotAccountOwnerError) {
      await store(deps, ctx.sub).clear();
      await telegram.sendMessage(chatId, NOT_OWNER);
      return;
    }
    throw error;
  }
}

// Free text while /renameaccount is open. False when there is no such
// dialogue, so the caller can fall back.
export async function handleRenameText(
  ctx: LinkedContext,
  text: string,
  deps: RenameDeps,
): Promise<boolean> {
  const conversation = await store(deps, ctx.sub).get<RenameState>();
  if (conversation?.kind !== RENAME_KIND) return false;
  if (conversation.state.step === 'name') {
    await complete(ctx, conversation.state, text, deps);
    return true;
  }
  // Typing is activity too: keep the dialogue (and its buttons) alive.
  await store(deps, ctx.sub).set(RENAME_KIND, conversation.state);
  await ctx.telegram.sendMessage(
    ctx.chatId,
    `Please use the buttons above. ${CANCEL_HINT}`,
  );
  return true;
}

export async function handleRenameCallback(
  ctx: LinkedContext,
  query: CallbackQuery,
  data: string,
  deps: RenameDeps,
): Promise<void> {
  const { telegram, chatId } = ctx;
  const [, nonce, value] = data.split(':');
  // Whatever happens, these buttons are spent.
  if (query.message) {
    await telegram
      .editMessageReplyMarkup(chatId, query.message.message_id)
      .catch(() => undefined);
  }
  const conversation = await store(deps, ctx.sub).get<RenameState>();
  if (
    conversation?.kind !== RENAME_KIND ||
    conversation.state.nonce !== nonce ||
    conversation.state.step !== 'account' ||
    !value
  ) {
    await telegram.sendMessage(chatId, EXPIRED);
    return;
  }
  const account = (await ownedAccounts(ctx, deps)).find((a) => a.id === value);
  if (!account) {
    await telegram.sendMessage(
      chatId,
      'That account is not available to you as an owner.',
    );
    return;
  }
  await store(deps, ctx.sub).set<RenameState>(RENAME_KIND, {
    nonce,
    step: 'name',
    accountId: account.id,
  });
  await askName(ctx, account);
}
