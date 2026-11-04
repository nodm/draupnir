// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import type { Update } from '@grammyjs/types';
import { applyMigrationsForTest, createPgliteDataApiClient } from 'shared';
import type { Context } from '../dispatcher';
import type { TelegramClient } from '../telegram';
import { handleLinkCallback, type CallbackDeps } from './callback';
import { createLinkStore } from './linkStore';
import { createSubResolver } from '../routes';
import { handleUnlinked } from './unlinked';

const dbConfig = { resourceArn: 'a', secretArn: 'b', database: 'c' };
const linkConfig = {
  cognitoBaseUrl: 'https://auth.example.com',
  clientId: 'tg-client',
  callbackUrl: 'https://api.example.com/telegram/callback',
  botUsername: 'DraupnirBot',
};

let db: PGlite;
let store: ReturnType<typeof createLinkStore>;
let resolveSub: ReturnType<typeof createSubResolver>;

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
  const { client } = createPgliteDataApiClient(db, { role: 'draupnir_app' });
  store = createLinkStore(client, dbConfig);
  resolveSub = createSubResolver(client, dbConfig);
}, 60_000);

afterAll(async () => {
  await db.close();
});

function fakeTelegram() {
  const sendMessage = vi.fn().mockResolvedValue({});
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  return {
    sendMessage,
    answerCallbackQuery,
    telegram: { sendMessage, answerCallbackQuery } as unknown as TelegramClient,
  };
}

function messageFrom(
  userId: number,
  extra: Record<string, unknown>,
  name = 'Ann',
): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: userId, type: 'private', first_name: name },
      from: { id: userId, is_bot: false, first_name: name, username: 'ann_u' },
      ...extra,
    },
  } as Update;
}

function ctxFor(userId: number, extra: Record<string, unknown>, name?: string) {
  const t = fakeTelegram();
  const ctx: Context = {
    update: messageFrom(userId, extra, name),
    chatId: userId,
    telegramUserId: userId,
    telegram: t.telegram,
  };
  return { ctx, ...t };
}

// What the user does in the chat: send something, get a sign-in link back.
async function requestLink(userId: number, text = '/start', name?: string) {
  const { ctx, sendMessage } = ctxFor(userId, { text }, name);
  await handleUnlinked(ctx, { store, config: linkConfig });
  const markup = sendMessage.mock.calls[0]?.[2]?.replyMarkup;
  const url = new URL(markup.inline_keyboard[0][0].url as string);
  return { url, state: url.searchParams.get('state') as string, sendMessage };
}

let subCounter = 0;

// Each call signs in as a fresh Google account unless told otherwise.
function callbackDeps(
  over: Partial<CallbackDeps> = {},
  sub = `sub-${++subCounter}`,
) {
  const notify = vi.fn().mockResolvedValue(undefined);
  const deps: CallbackDeps = {
    store,
    config: linkConfig,
    exchangeCode: vi.fn().mockResolvedValue('id-token'),
    verifyIdToken: vi.fn().mockResolvedValue({ sub, email: 'ann@example.com' }),
    notify,
    newCode: () => '123456',
    ...over,
  };
  return { deps, notify };
}

const sendCode = async (userId: number, code: string) => {
  const { ctx, sendMessage } = ctxFor(userId, { text: code });
  await handleUnlinked(ctx, { store, config: linkConfig });
  return sendMessage.mock.calls.at(-1)?.[1] as string;
};

describe('sign-in link', () => {
  it('is a Cognito authorize URL with PKCE S256, a state, and the callback', async () => {
    const { url } = await requestLink(1001);
    expect(url.origin + url.pathname).toBe(
      'https://auth.example.com/oauth2/authorize',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('tg-client');
    expect(url.searchParams.get('redirect_uri')).toBe(linkConfig.callbackUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
  });

  it('is issued for a file, a command, or any text from an unlinked user', async () => {
    for (const [i, extra] of [
      { document: { file_id: 'f', file_unique_id: 'u' } },
      { text: '/accounts' },
      { text: 'hello' },
    ].entries()) {
      const { ctx, sendMessage } = ctxFor(1010 + i, extra);
      await handleUnlinked(ctx, { store, config: linkConfig });
      expect(sendMessage.mock.calls[0]?.[2]?.replyMarkup).toBeDefined();
    }
  });
});

describe('successful link', () => {
  it('links only after the requesting Telegram user sends the code', async () => {
    const { state } = await requestLink(2001);
    const { deps, notify } = callbackDeps({}, 'sub-ann');

    const page = await handleLinkCallback({ code: 'auth-code', state }, deps);

    expect(page.statusCode).toBe(200);
    expect(page.html).toContain('123456');
    expect(page.html).toContain('Ann');
    expect(page.html).toContain('@ann_u');
    expect(page.html).toContain('@DraupnirBot');
    expect(page.html).toMatch(/never share/i);
    expect(notify).toHaveBeenCalledWith(
      2001,
      expect.stringContaining('6-digit'),
    );
    // sign-in alone linked nothing
    expect(await resolveSub(2001)).toBeNull();

    expect(await sendCode(2001, '123456')).toContain('ann@example.com');
    expect(await resolveSub(2001)).toBe('sub-ann');
  });

  it('exchanges the code with the PKCE verifier stored for that request', async () => {
    const { state } = await requestLink(2002);
    const { deps } = callbackDeps();
    await handleLinkCallback({ code: 'auth-code', state }, deps);
    expect(deps.exchangeCode).toHaveBeenCalledWith({
      code: 'auth-code',
      codeVerifier: expect.stringMatching(/^[\w-]{43}$/),
    });
  });
});

describe('forwarded sign-in link', () => {
  it('does not link the forwarder; the page names the requester', async () => {
    // X asks, forwards the link to V, V signs in.
    const { state } = await requestLink(3001, '/start', 'Mallory');
    const { deps } = callbackDeps({
      verifyIdToken: vi
        .fn()
        .mockResolvedValue({ sub: 'victim', email: 'v@example.com' }),
    });
    const page = await handleLinkCallback({ code: 'c', state }, deps);

    expect(page.html).toContain('Mallory');
    expect(await resolveSub(3001)).toBeNull();
    // X cannot guess: without the code, nothing links
    expect(await sendCode(3001, '000000')).toMatch(/wrong/i);
    expect(await resolveSub(3001)).toBeNull();
  });

  it('refuses a code sent from a different Telegram account', async () => {
    const { state } = await requestLink(3002);
    await handleLinkCallback({ code: 'c', state }, callbackDeps().deps);

    const reply = await sendCode(3999, '123456');

    expect(reply).toBeDefined();
    expect(await resolveSub(3999)).toBeNull();
    expect(await resolveSub(3002)).toBeNull();
  });
});

describe('wrong codes', () => {
  it('the 5th wrong code cancels the request', async () => {
    const { state } = await requestLink(4001);
    await handleLinkCallback({ code: 'c', state }, callbackDeps().deps);

    for (let i = 0; i < 4; i++) {
      expect(await sendCode(4001, '999999')).toMatch(/wrong/i);
    }
    expect(await sendCode(4001, '999999')).toMatch(/cancelled/i);
    // the right code no longer works
    await sendCode(4001, '123456');
    expect(await resolveSub(4001)).toBeNull();
  });
});

describe('expired or reused state', () => {
  it('refuses a state that was already used', async () => {
    const { state } = await requestLink(5001);
    const { deps } = callbackDeps();
    await handleLinkCallback({ code: 'c', state }, deps);

    const second = await handleLinkCallback({ code: 'c', state }, deps);

    expect(second.statusCode).toBe(400);
    expect(second.html).toMatch(/expired or was already used/);
    expect(deps.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('refuses a state older than 10 minutes', async () => {
    const { ctx, sendMessage } = ctxFor(5002, { text: '/start' });
    await handleUnlinked(ctx, {
      store,
      config: linkConfig,
      now: () => new Date(Date.now() - 11 * 60 * 1000),
    });
    const url = new URL(
      sendMessage.mock.calls[0]?.[2].replyMarkup.inline_keyboard[0][0].url,
    );
    const { deps } = callbackDeps();

    const page = await handleLinkCallback(
      { code: 'c', state: url.searchParams.get('state') as string },
      deps,
    );

    expect(page.html).toMatch(/expired or was already used/);
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses an unknown state', async () => {
    const { deps } = callbackDeps();
    const page = await handleLinkCallback({ code: 'c', state: 'nope' }, deps);
    expect(page.statusCode).toBe(400);
  });
});

describe('failed sign-in', () => {
  it('creates no link when Cognito reports an error (e.g. not allowlisted)', async () => {
    const { state } = await requestLink(6001);
    const { deps } = callbackDeps();

    const page = await handleLinkCallback(
      { error: 'access_denied', state },
      deps,
    );

    expect(page.statusCode).toBe(400);
    expect(deps.exchangeCode).not.toHaveBeenCalled();
    expect(await resolveSub(6001)).toBeNull();
  });

  it.each([
    [
      'token exchange',
      { exchangeCode: vi.fn().mockRejectedValue(new Error('400')) },
    ],
    [
      'ID token verification',
      { verifyIdToken: vi.fn().mockRejectedValue(new Error('bad sig')) },
    ],
  ])('creates no pending link when %s fails', async (_label, over) => {
    const userId = 6100 + Math.floor(Math.random() * 1000);
    const { state } = await requestLink(userId);
    const { deps, notify } = callbackDeps(over);

    const page = await handleLinkCallback({ code: 'c', state }, deps);

    expect(page.statusCode).toBe(400);
    expect(page.html).not.toMatch(/\d{6}/);
    expect(notify).not.toHaveBeenCalled();
    expect(await store.hasPending(userId)).toBe(false);
    expect(await resolveSub(userId)).toBeNull();
  });
});

describe('one-to-one links', () => {
  it('tells the second Telegram user when the Google account is already linked', async () => {
    const first = await requestLink(7001);
    await handleLinkCallback(
      { code: 'c', state: first.state },
      callbackDeps({}, 'shared-sub').deps,
    );
    await sendCode(7001, '123456');
    expect(await resolveSub(7001)).toBe('shared-sub');

    const second = await requestLink(7002);
    const { deps, notify } = callbackDeps({}, 'shared-sub');
    const page = await handleLinkCallback(
      { code: 'c', state: second.state },
      deps,
    );

    expect(page.statusCode).toBe(409);
    expect(notify).toHaveBeenCalledWith(
      7002,
      expect.stringMatching(/already linked/),
    );
    expect(await resolveSub(7002)).toBeNull();
  });
});

describe('one-to-one links: racing link', () => {
  it('tells the chat to unlink itself (not the Google account) when the Telegram account got linked meanwhile', async () => {
    const { state } = await requestLink(7101);
    // another sign-in for this Telegram account finished first
    await db.exec(
      `INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (7101, 'raced-sub', 'r@example.com')`,
    );
    const { deps, notify } = callbackDeps({}, 'brand-new-sub');

    const page = await handleLinkCallback({ code: 'c', state }, deps);

    expect(page.statusCode).toBe(409);
    const text = notify.mock.calls[0]?.[1] as string;
    expect(text).toMatch(/This Telegram account is already linked/);
    expect(text).not.toMatch(/Google account is already linked/);
  });

  it('names the Google account when that is what is already linked', async () => {
    await db.exec(
      `INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (7102, 'taken-sub', 't@example.com')`,
    );
    const { state } = await requestLink(7103);
    const { deps, notify } = callbackDeps({}, 'taken-sub');

    await handleLinkCallback({ code: 'c', state }, deps);

    expect(notify.mock.calls[0]?.[1]).toMatch(
      /Google account is already linked to another Telegram account/,
    );
  });
});

describe('mid-link messages', () => {
  it('an unrelated message does not replace the pending request', async () => {
    const { state } = await requestLink(8001);
    await handleLinkCallback({ code: 'c', state }, callbackDeps().deps);

    const { ctx, sendMessage } = ctxFor(8001, { text: 'hello?' });
    await handleUnlinked(ctx, { store, config: linkConfig });
    expect(sendMessage.mock.calls[0]?.[1]).toMatch(/6-digit code/);
    expect(sendMessage.mock.calls[0]?.[2]).toBeUndefined();

    expect(await sendCode(8001, '123456')).toContain('Linked');
  });

  it('/start does issue a fresh link and discards the pending one', async () => {
    const { state } = await requestLink(8002);
    await handleLinkCallback({ code: 'c', state }, callbackDeps().deps);

    await requestLink(8002, '/start');
    await sendCode(8002, '123456');

    expect(await resolveSub(8002)).toBeNull();
  });
});

describe('page safety', () => {
  it('escapes an attacker-controlled Telegram display name', async () => {
    const { state } = await requestLink(
      9001,
      '/start',
      '<script>alert(1)</script>',
    );
    const page = await handleLinkCallback(
      { code: 'c', state },
      callbackDeps().deps,
    );

    expect(page.html).not.toContain('<script>alert(1)</script>');
    expect(page.html).toContain('&lt;script&gt;');
  });
});

describe('button press from an unlinked user', () => {
  it('gets a sign-in link (the dispatcher answers the button itself)', async () => {
    const t = fakeTelegram();
    const ctx: Context = {
      update: {
        update_id: 3,
        callback_query: {
          id: 'q1',
          from: { id: 9100, is_bot: false, first_name: 'Ann' },
          chat_instance: 'c',
          data: 'confirm',
          message: {
            message_id: 4,
            date: 0,
            chat: { id: 9100, type: 'private' },
          },
        },
      } as Update,
      chatId: 9100,
      telegramUserId: 9100,
      telegram: t.telegram,
    };

    await handleUnlinked(ctx, { store, config: linkConfig });

    expect(t.sendMessage.mock.calls[0]?.[2]?.replyMarkup).toBeDefined();
  });
});
