import { randomBytes } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { CallbackQuery } from '@grammyjs/types';
import {
  addMember,
  AlreadyMemberError,
  LastOwnerError,
  MemberNotFoundError,
  NotAccountOwnerError,
  removeMember,
  type DataApiConfig,
  type MemberRole,
} from 'shared';
import { accountLabel } from '../accounts/format';
import { createConversationStore } from '../conversations';
import type { UserDirectory } from '../directory';
import type { CommandHandler, LinkedContext } from '../dispatcher';
import { listMemberAccounts, type MemberAccount } from '../memberAccounts';
import { notify, whoIs } from '../notify';
import { listMembers, memberChatId } from '../sharing';

export const SHARE_KIND = 'share';
export const UNSHARE_KIND = 'unshare';
export const SHARE_ACCOUNT_PREFIX = 'sa';
export const SHARE_ROLE_PREFIX = 'sr';
export const UNSHARE_ACCOUNT_PREFIX = 'ua';
export const UNSHARE_MEMBER_PREFIX = 'um';

export interface SharingDeps {
  client: RDSDataClient;
  config: DataApiConfig;
  directory: UserDirectory;
}

// `nonce` ties buttons to this dialogue; buttons of an earlier one are refused.
interface ShareState {
  nonce: string;
  step: 'account' | 'email' | 'role';
  accountId?: string;
  targetSub?: string;
  targetEmail?: string;
}

interface UnshareState {
  nonce: string;
  step: 'account' | 'member';
  accountId?: string;
}

const store = (deps: SharingDeps, sub: string) =>
  createConversationStore(deps.client, deps.config, sub);

const CANCEL_HINT = 'Send /cancel to stop.';
const EXPIRED =
  'That request has expired. Send /share or /unshare to start again.';
const EMAIL = /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/;

async function ownedAccounts(
  ctx: LinkedContext,
  deps: SharingDeps,
): Promise<MemberAccount[]> {
  return (await listMemberAccounts(deps.client, deps.config, ctx.sub)).filter(
    (a) => a.role === 'owner',
  );
}

function accountButtons(
  prefix: string,
  nonce: string,
  accounts: MemberAccount[],
) {
  return {
    inline_keyboard: accounts.map((a) => [
      { text: accountLabel(a), callback_data: `${prefix}:${nonce}:${a.id}` },
    ]),
  };
}

// --- /share -----------------------------------------------------------------

async function askEmail(ctx: LinkedContext, account: MemberAccount) {
  await ctx.telegram.sendMessage(
    ctx.chatId,
    `Share ${accountLabel(account)}. What is the email of the person (the Google address they sign in to Draupnir with)? ${CANCEL_HINT}`,
  );
}

export function createShareHandler(deps: SharingDeps): CommandHandler {
  return async (ctx) => {
    const accounts = await ownedAccounts(ctx, deps);
    if (accounts.length === 0) {
      await ctx.telegram.sendMessage(
        ctx.chatId,
        'You do not own any account, so there is nothing to share. Only an owner can share an account.',
      );
      return;
    }
    const nonce = randomBytes(4).toString('hex');
    const only = accounts.length === 1 ? accounts[0] : undefined;
    await store(deps, ctx.sub).set<ShareState>(SHARE_KIND, {
      nonce,
      step: only ? 'email' : 'account',
      accountId: only?.id,
    });
    if (only) {
      await askEmail(ctx, only);
      return;
    }
    await ctx.telegram.sendMessage(
      ctx.chatId,
      'Which account do you want to share?',
      {
        replyMarkup: accountButtons(SHARE_ACCOUNT_PREFIX, nonce, accounts),
      },
    );
  };
}

async function handleShareEmail(
  ctx: LinkedContext,
  text: string,
  state: ShareState,
  deps: SharingDeps,
): Promise<void> {
  const { telegram, chatId } = ctx;
  const email = text.trim().toLowerCase();
  const keep = () => store(deps, ctx.sub).set<ShareState>(SHARE_KIND, state);

  if (!EMAIL.test(email) || email.length > 254) {
    await keep(); // an attempt is activity: the idle expiry restarts
    await telegram.sendMessage(
      chatId,
      'That does not look like an email address. Send it again.',
    );
    return;
  }
  const found = await deps.directory.findByEmail(email);
  if (!found) {
    await keep();
    await telegram.sendMessage(
      chatId,
      'Nobody is registered with that email. They must sign in to Draupnir first (/start in this bot), then you can share. Send another email, or /cancel.',
    );
    return;
  }
  if (found.sub === ctx.sub) {
    await keep();
    await telegram.sendMessage(
      chatId,
      'That is your own email. Send the email of the person to share with.',
    );
    return;
  }
  await store(deps, ctx.sub).set<ShareState>(SHARE_KIND, {
    ...state,
    step: 'role',
    targetSub: found.sub,
    targetEmail: found.email,
  });
  await telegram.sendMessage(
    chatId,
    `Which access should ${found.email} get?`,
    {
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: 'Viewer (can read)',
              callback_data: `${SHARE_ROLE_PREFIX}:${state.nonce}:viewer`,
            },
            {
              text: 'Owner (can also share and import)',
              callback_data: `${SHARE_ROLE_PREFIX}:${state.nonce}:owner`,
            },
          ],
        ],
      },
    },
  );
}

async function completeShare(
  ctx: LinkedContext,
  state: ShareState,
  role: MemberRole,
  deps: SharingDeps,
): Promise<void> {
  const { telegram, chatId } = ctx;
  const accountId = state.accountId as string;
  const targetSub = state.targetSub as string;
  const account = (await ownedAccounts(ctx, deps)).find(
    (a) => a.id === accountId,
  );
  if (!account) {
    await store(deps, ctx.sub).clear();
    await telegram.sendMessage(
      chatId,
      'You are not an owner of that account any more, so nothing was shared.',
    );
    return;
  }
  try {
    await addMember(deps.client, deps.config, ctx.sub, {
      accountId,
      userId: targetSub,
      role,
    });
  } catch (error) {
    await store(deps, ctx.sub).clear();
    if (error instanceof AlreadyMemberError) {
      await telegram.sendMessage(
        chatId,
        `${state.targetEmail} already has access to ${accountLabel(account)}. Use /unshare first to change their access.`,
      );
      return;
    }
    if (error instanceof NotAccountOwnerError) {
      await telegram.sendMessage(
        chatId,
        'You are not an owner of that account any more, so nothing was shared.',
      );
      return;
    }
    throw error;
  }
  await store(deps, ctx.sub).clear();
  const chat = await memberChatId(
    deps.client,
    deps.config,
    ctx.sub,
    accountId,
    targetSub,
  ).catch(() => null);
  const note = await notify(
    ctx,
    chat,
    `${await whoIs(ctx, deps.directory)} shared ${accountLabel(account)} with you as ${role}. Send /accounts to see it.`,
  );
  await telegram.sendMessage(
    chatId,
    `${state.targetEmail} now has ${role} access to ${accountLabel(account)}.${note}`,
  );
}

// --- /unshare ---------------------------------------------------------------

export function createUnshareHandler(deps: SharingDeps): CommandHandler {
  return async (ctx) => {
    const accounts = await ownedAccounts(ctx, deps);
    if (accounts.length === 0) {
      await ctx.telegram.sendMessage(
        ctx.chatId,
        'You do not own any account. Only an owner can remove people from an account.',
      );
      return;
    }
    const nonce = randomBytes(4).toString('hex');
    if (accounts.length === 1) {
      await askMember(ctx, deps, nonce, accounts[0] as MemberAccount);
      return;
    }
    await store(deps, ctx.sub).set<UnshareState>(UNSHARE_KIND, {
      nonce,
      step: 'account',
    });
    await ctx.telegram.sendMessage(
      ctx.chatId,
      'Remove someone from which account?',
      {
        replyMarkup: accountButtons(UNSHARE_ACCOUNT_PREFIX, nonce, accounts),
      },
    );
  };
}

async function askMember(
  ctx: LinkedContext,
  deps: SharingDeps,
  nonce: string,
  account: MemberAccount,
): Promise<void> {
  const members = await listMembers(
    deps.client,
    deps.config,
    ctx.sub,
    account.id,
  );
  const labelled = await Promise.all(
    members.map(async (m) => {
      const email = await deps.directory.emailOf(m.userId).catch(() => null);
      const who = m.userId === ctx.sub ? 'You' : (email ?? 'Unknown user');
      return { member: m, text: `${who} · ${m.role}` };
    }),
  );
  await store(deps, ctx.sub).set<UnshareState>(UNSHARE_KIND, {
    nonce,
    step: 'member',
    accountId: account.id,
  });
  await ctx.telegram.sendMessage(
    ctx.chatId,
    `Who should lose access to ${accountLabel(account)}?`,
    {
      replyMarkup: {
        inline_keyboard: labelled.map(({ member, text }) => [
          {
            text,
            callback_data: `${UNSHARE_MEMBER_PREFIX}:${nonce}:${member.userId}`,
          },
        ]),
      },
    },
  );
}

async function completeUnshare(
  ctx: LinkedContext,
  state: UnshareState,
  targetSub: string,
  deps: SharingDeps,
): Promise<void> {
  const { telegram, chatId } = ctx;
  const accountId = state.accountId as string;
  const account = (await ownedAccounts(ctx, deps)).find(
    (a) => a.id === accountId,
  );
  if (!account) {
    await store(deps, ctx.sub).clear();
    await telegram.sendMessage(
      chatId,
      'You are not an owner of that account any more, so nothing was changed.',
    );
    return;
  }
  // Looked up first: once removed, they are no longer a member to look up.
  const chat = await memberChatId(
    deps.client,
    deps.config,
    ctx.sub,
    accountId,
    targetSub,
  ).catch(() => null);
  const email = await deps.directory.emailOf(targetSub).catch(() => null);
  try {
    await removeMember(deps.client, deps.config, ctx.sub, {
      accountId,
      userId: targetSub,
    });
  } catch (error) {
    if (error instanceof LastOwnerError) {
      // The dialogue stays open so another member can be picked; writing the
      // state back restarts its idle expiry from this attempt.
      await store(deps, ctx.sub).set<UnshareState>(UNSHARE_KIND, state);
      await telegram.sendMessage(
        chatId,
        'An account must keep at least one owner, so the last owner cannot be removed. Make someone else an owner with /share first. Nothing was changed.',
      );
      return;
    }
    await store(deps, ctx.sub).clear();
    if (error instanceof MemberNotFoundError) {
      await telegram.sendMessage(
        chatId,
        'That person no longer has access to the account. Nothing was changed.',
      );
      return;
    }
    if (error instanceof NotAccountOwnerError) {
      await telegram.sendMessage(
        chatId,
        'You are not an owner of that account any more, so nothing was changed.',
      );
      return;
    }
    throw error;
  }
  await store(deps, ctx.sub).clear();
  const label = accountLabel(account);
  if (targetSub === ctx.sub) {
    await telegram.sendMessage(
      chatId,
      `You no longer have access to ${label}.`,
    );
    return;
  }
  const note = await notify(
    ctx,
    chat,
    `${await whoIs(ctx, deps.directory)} removed your access to ${label}.`,
  );
  await telegram.sendMessage(
    chatId,
    `${email ?? 'That person'} no longer has access to ${label}.${note}`,
  );
}

// --- shared plumbing ----------------------------------------------------------

// Free text while /share is waiting for an email. False when there is no
// sharing dialogue, so the caller can fall back.
export async function handleSharingText(
  ctx: LinkedContext,
  text: string,
  deps: SharingDeps,
): Promise<boolean> {
  const conversation = await store(deps, ctx.sub).get<
    ShareState | UnshareState
  >();
  if (
    conversation?.kind !== SHARE_KIND &&
    conversation?.kind !== UNSHARE_KIND
  ) {
    return false;
  }
  if (
    conversation.kind === SHARE_KIND &&
    (conversation.state as ShareState).step === 'email'
  ) {
    await handleShareEmail(ctx, text, conversation.state as ShareState, deps);
    return true;
  }
  // Typing is activity too: keep the dialogue (and its buttons) alive.
  await store(deps, ctx.sub).set(conversation.kind, conversation.state);
  await ctx.telegram.sendMessage(
    ctx.chatId,
    `Please use the buttons above. ${CANCEL_HINT}`,
  );
  return true;
}

export async function handleSharingCallback(
  ctx: LinkedContext,
  query: CallbackQuery,
  data: string,
  deps: SharingDeps,
): Promise<void> {
  const { telegram, chatId } = ctx;
  const [prefix, nonce, value] = data.split(':');
  const kind =
    prefix === SHARE_ACCOUNT_PREFIX || prefix === SHARE_ROLE_PREFIX
      ? SHARE_KIND
      : UNSHARE_KIND;
  const conversation = await store(deps, ctx.sub).get<
    ShareState | UnshareState
  >();

  // Whatever happens, these buttons are spent. (Removing a member is the one
  // exception, handled below: a refused last-owner removal keeps the list.)
  const keepsButtons = prefix === UNSHARE_MEMBER_PREFIX;
  if (query.message && !keepsButtons) {
    await telegram
      .editMessageReplyMarkup(chatId, query.message.message_id)
      .catch(() => undefined);
  }

  const expectedStep =
    prefix === SHARE_ACCOUNT_PREFIX || prefix === UNSHARE_ACCOUNT_PREFIX
      ? 'account'
      : prefix === SHARE_ROLE_PREFIX
        ? 'role'
        : 'member';
  if (
    !conversation ||
    conversation.kind !== kind ||
    conversation.state.nonce !== nonce ||
    conversation.state.step !== expectedStep ||
    !value
  ) {
    await telegram.sendMessage(chatId, EXPIRED);
    return;
  }

  if (prefix === SHARE_ACCOUNT_PREFIX) {
    const account = (await ownedAccounts(ctx, deps)).find(
      (a) => a.id === value,
    );
    if (!account) {
      await telegram.sendMessage(
        chatId,
        'That account is not available to you as an owner.',
      );
      return;
    }
    await store(deps, ctx.sub).set<ShareState>(SHARE_KIND, {
      nonce: conversation.state.nonce,
      step: 'email',
      accountId: account.id,
    });
    await askEmail(ctx, account);
    return;
  }
  if (prefix === SHARE_ROLE_PREFIX) {
    if (value !== 'viewer' && value !== 'owner') return;
    await completeShare(ctx, conversation.state as ShareState, value, deps);
    return;
  }
  if (prefix === UNSHARE_ACCOUNT_PREFIX) {
    const account = (await ownedAccounts(ctx, deps)).find(
      (a) => a.id === value,
    );
    if (!account) {
      await telegram.sendMessage(
        chatId,
        'That account is not available to you as an owner.',
      );
      return;
    }
    await askMember(ctx, deps, conversation.state.nonce, account);
    return;
  }
  await completeUnshare(ctx, conversation.state as UnshareState, value, deps);
  // The list is spent once a removal went through (or the dialogue ended).
  if (query.message && !(await store(deps, ctx.sub).get())) {
    await telegram
      .editMessageReplyMarkup(chatId, query.message.message_id)
      .catch(() => undefined);
  }
}
