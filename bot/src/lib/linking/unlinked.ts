import type { InlineKeyboardMarkup } from '@grammyjs/types';
import type { Context } from '../dispatcher';
import { LINK_REQUEST_TTL_MS, type LinkConfig } from './config';
import { pkceChallenge, randomToken, sha256Hex } from './crypto';
import type { LinkStore } from './linkStore';

export interface UnlinkedDeps {
  store: LinkStore;
  config: LinkConfig;
  now?: () => Date;
}

export function buildAuthorizeUrl(
  config: LinkConfig,
  state: string,
  verifier: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: 'openid email',
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    // The pool's only provider; skips the hosted-UI chooser.
    identity_provider: 'Google',
  });
  return `${config.cognitoBaseUrl}/oauth2/authorize?${params.toString()}`;
}

const CODE_PATTERN = /^\d{6}$/;

// The only thing an unlinked Telegram user can do: link. Whatever they send
// (command, file, text, button) ends in a sign-in link or a code check; nothing
// they send is processed or stored.
export async function handleUnlinked(
  ctx: Context,
  deps: UnlinkedDeps,
): Promise<void> {
  const { telegram, chatId, telegramUserId, update } = ctx;
  const message = update.message;
  const text = message?.text?.trim() ?? '';

  if (CODE_PATTERN.test(text)) {
    const result = await deps.store.redeem(telegramUserId, sha256Hex(text));
    switch (result.status) {
      case 'linked':
        await telegram.sendMessage(
          chatId,
          `Linked to ${result.email}. Send a bank statement CSV, or /accounts to get started.`,
        );
        return;
      case 'wrong':
        await telegram.sendMessage(chatId, 'That code is wrong. Try again.');
        return;
      case 'cancelled':
        await telegram.sendMessage(
          chatId,
          'Too many wrong codes, so this sign-in was cancelled. Send /start to try again.',
        );
        return;
      case 'expired':
        await telegram.sendMessage(
          chatId,
          'That code has expired. Send /start to get a new sign-in link.',
        );
        return;
      case 'already_linked':
        await telegram.sendMessage(
          chatId,
          'This Telegram account or that Google account is already linked. Send /unlink from the linked chat first.',
        );
        return;
      case 'none':
        break; // no pending sign-in: fall through to issue a link
    }
  }

  // Mid-link: don't let an unrelated message replace the pending request.
  const isStart = /^\/start(?:@\w+)?(?:\s|$)/.test(text);
  if (!isStart && (await deps.store.hasPending(telegramUserId))) {
    await telegram.sendMessage(
      chatId,
      'Send the 6-digit code shown in your browser after signing in, or /start for a new sign-in link.',
    );
    return;
  }

  const from = message?.from ?? update.callback_query?.from;
  const state = randomToken();
  const verifier = randomToken();
  const now = (deps.now ?? (() => new Date()))();
  await deps.store.createRequest({
    stateHash: sha256Hex(state),
    telegramUserId,
    chatId,
    displayName:
      [from?.first_name, from?.last_name].filter(Boolean).join(' ') ||
      String(telegramUserId),
    username: from?.username ?? null,
    pkceVerifier: verifier,
    expiresAt: new Date(now.getTime() + LINK_REQUEST_TTL_MS),
  });

  const markup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: 'Sign in with Google',
          url: buildAuthorizeUrl(deps.config, state, verifier),
        },
      ],
    ],
  };
  await telegram.sendMessage(
    chatId,
    'Sign in with Google to link this chat to your Draupnir account. The link works for 10 minutes. Afterwards you will get a 6-digit code: send it here to finish.',
    { replyMarkup: markup },
  );
}
