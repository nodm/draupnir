import { confirmationCode, sha256Hex } from './crypto';
import type { LinkConfig } from './config';
import type { IdTokenVerifier } from './idToken';
import type { LinkStore } from './linkStore';
import {
  ALREADY_LINKED_PAGE,
  codePage,
  EXPIRED_PAGE,
  FAILED_PAGE,
} from './page';

export interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

export interface CallbackDeps {
  store: LinkStore;
  config: LinkConfig;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<string>;
  verifyIdToken: IdTokenVerifier;
  // Best-effort message to the Telegram chat that asked to link.
  notify(chatId: number, text: string): Promise<void>;
  newCode?: () => string;
}

export interface CallbackResult {
  statusCode: number;
  html: string;
}

const page = (statusCode: number, html: string): CallbackResult => ({
  statusCode,
  html,
});

// Completing sign-in links nothing. It stores a pending link plus a one-time
// code that only this signed-in browser sees; the link is created when the
// requesting Telegram account sends that code to the bot.
export async function handleLinkCallback(
  query: CallbackQuery,
  deps: CallbackDeps,
): Promise<CallbackResult> {
  // Cognito sends `error` when sign-in is refused (e.g. not on the allowlist).
  if (query.error || !query.code || !query.state) {
    return page(400, FAILED_PAGE);
  }

  const stateHash = sha256Hex(query.state);
  const request = await deps.store.consumeState(stateHash);
  if (!request) {
    return page(400, EXPIRED_PAGE);
  }

  let identity;
  try {
    const idToken = await deps.exchangeCode({
      code: query.code,
      codeVerifier: request.pkceVerifier,
    });
    identity = await deps.verifyIdToken(idToken);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'link-callback-failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return page(400, FAILED_PAGE);
  }

  const code = (deps.newCode ?? confirmationCode)();
  const result = await deps.store.setPending(
    stateHash,
    identity.sub,
    identity.email,
    sha256Hex(code),
  );

  if (result === 'sub_already_linked' || result === 'telegram_already_linked') {
    await deps
      .notify(
        request.chatId,
        'That Google account is already linked to a Telegram account. Send /unlink from the linked chat first.',
      )
      .catch(() => undefined);
    return page(409, ALREADY_LINKED_PAGE);
  }
  if (result !== 'ok') {
    return page(400, EXPIRED_PAGE);
  }

  await deps
    .notify(
      request.chatId,
      'Signed in. Now send the 6-digit code shown in your browser to finish linking.',
    )
    .catch(() => undefined);

  return page(
    200,
    codePage({
      displayName: request.displayName,
      username: request.username,
      code,
      botUsername: deps.config.botUsername,
    }),
  );
}
