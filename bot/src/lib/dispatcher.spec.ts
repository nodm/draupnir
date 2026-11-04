import type { Update } from '@grammyjs/types';
import { dispatch, HELP_TEXT, parseCommand, type Routes } from './dispatcher';
import type { TelegramClient } from './telegram';

const user = { id: 7, is_bot: false, first_name: 'Ann' };
const chat = { id: 7, type: 'private' as const, first_name: 'Ann' };

const message = (extra: Record<string, unknown>): Update =>
  ({
    update_id: 1,
    message: { message_id: 1, date: 0, chat, from: user, ...extra },
  }) as Update;

function setup(sub: string | null) {
  const telegram = {
    sendMessage: vi.fn().mockResolvedValue({}),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelegramClient;
  const routes = {
    resolveSub: vi.fn().mockResolvedValue(sub),
    onUnlinked: vi.fn().mockResolvedValue(undefined),
    commands: { accounts: vi.fn().mockResolvedValue(undefined) },
    onDocument: vi.fn().mockResolvedValue(undefined),
    onCallback: vi.fn().mockResolvedValue(undefined),
    onText: vi.fn().mockResolvedValue(undefined),
  } satisfies Routes;
  return { telegram, routes };
}

describe('parseCommand', () => {
  it('parses name and arguments, dropping the bot suffix and case', () => {
    expect(parseCommand('/Share@DraupnirBot a@b.com')).toEqual({
      name: 'share',
      args: 'a@b.com',
    });
    expect(parseCommand('/accounts')).toEqual({ name: 'accounts', args: '' });
  });

  it('returns null for text that is not a command', () => {
    expect(parseCommand('hello /accounts')).toBeNull();
  });
});

describe('dispatch for linked users', () => {
  it('runs a registered command as the linked sub', async () => {
    const { telegram, routes } = setup('sub-1');
    await dispatch(message({ text: '/accounts now' }), telegram, routes);

    expect(routes.commands.accounts).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'sub-1', chatId: 7, telegramUserId: 7 }),
      'now',
    );
    expect(routes.onUnlinked).not.toHaveBeenCalled();
  });

  it('answers an unknown command (including /start) with help', async () => {
    const { telegram, routes } = setup('sub-1');
    await dispatch(message({ text: '/start' }), telegram, routes);

    expect(telegram.sendMessage).toHaveBeenCalledWith(7, HELP_TEXT);
    expect(routes.onText).not.toHaveBeenCalled();
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'answers /%s with help instead of resolving an inherited property',
    async (name) => {
      const { telegram, routes } = setup('sub-1');
      await dispatch(message({ text: `/${name}` }), telegram, routes);

      expect(telegram.sendMessage).toHaveBeenCalledWith(7, HELP_TEXT);
    },
  );

  it('sends free text to the text handler', async () => {
    const { telegram, routes } = setup('sub-1');
    await dispatch(
      message({ text: 'how much did I spend?' }),
      telegram,
      routes,
    );
    expect(routes.onText).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'sub-1' }),
      'how much did I spend?',
    );
  });

  it('sends a document to the document handler', async () => {
    const { telegram, routes } = setup('sub-1');
    const document = { file_id: 'f', file_unique_id: 'u', file_name: 'a.csv' };
    await dispatch(message({ document }), telegram, routes);
    expect(routes.onDocument).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'sub-1' }),
      expect.objectContaining({ document }),
      document,
    );
  });

  it('sends a button press with its data to the callback handler', async () => {
    const { telegram, routes } = setup('sub-1');
    await dispatch(
      {
        update_id: 2,
        callback_query: {
          id: 'q1',
          from: user,
          chat_instance: 'c',
          data: 'acct:1',
          message: { message_id: 3, date: 0, chat },
        },
      } as Update,
      telegram,
      routes,
    );
    expect(routes.onCallback).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'sub-1' }),
      expect.objectContaining({ id: 'q1' }),
      'acct:1',
    );
  });
});

describe('dispatch for unlinked users', () => {
  it.each([
    ['a command', { text: '/accounts' }],
    ['a CSV file', { document: { file_id: 'f', file_unique_id: 'u' } }],
    ['free text', { text: 'hello' }],
  ])('%s only reaches the link handler', async (_label, extra) => {
    const { telegram, routes } = setup(null);
    await dispatch(message(extra), telegram, routes);

    expect(routes.onUnlinked).toHaveBeenCalledTimes(1);
    expect(routes.commands.accounts).not.toHaveBeenCalled();
    expect(routes.onDocument).not.toHaveBeenCalled();
    expect(routes.onText).not.toHaveBeenCalled();
  });

  it('removes a statement sent from an unlinked chat after the refusal, and only a statement', async () => {
    const withFile = setup(null);
    await dispatch(
      message({
        message_id: 77,
        document: { file_id: 'f', file_unique_id: 'u' },
      }),
      withFile.telegram,
      withFile.routes,
    );
    expect(withFile.telegram.deleteMessage).toHaveBeenCalledWith(7, 77);
    // after the reply, not before
    expect(withFile.routes.onUnlinked.mock.invocationCallOrder[0]).toBeLessThan(
      (withFile.telegram.deleteMessage as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] as number,
    );

    const textOnly = setup(null);
    await dispatch(
      message({ text: 'hello' }),
      textOnly.telegram,
      textOnly.routes,
    );
    expect(textOnly.telegram.deleteMessage).not.toHaveBeenCalled();
  });

  it('a button press only reaches the link handler', async () => {
    const { telegram, routes } = setup(null);
    await dispatch(
      {
        update_id: 2,
        callback_query: {
          id: 'q',
          from: user,
          chat_instance: 'c',
          data: 'x',
          message: { message_id: 3, date: 0, chat },
        },
      } as Update,
      telegram,
      routes,
    );
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('q');
    expect(routes.onUnlinked).toHaveBeenCalledTimes(1);
    expect(routes.onCallback).not.toHaveBeenCalled();
  });
});

describe('dispatch ignores what it cannot serve', () => {
  it('ignores group chats, bots, and non-message updates without a lookup', async () => {
    const { telegram, routes } = setup('sub-1');
    await dispatch(
      message({ chat: { id: -1, type: 'group', title: 'g' }, text: 'hi' }),
      telegram,
      routes,
    );
    await dispatch(
      message({ from: { ...user, is_bot: true }, text: 'hi' }),
      telegram,
      routes,
    );
    await dispatch({ update_id: 9 } as Update, telegram, routes);
    // a button press that carries no message has no chat to answer in
    await dispatch(
      {
        update_id: 10,
        callback_query: { id: 'q', from: user, chat_instance: 'c', data: 'x' },
      } as unknown as Update,
      telegram,
      routes,
    );

    expect(routes.resolveSub).not.toHaveBeenCalled();
  });

  it('propagates a handler failure so the update is retried', async () => {
    const { telegram, routes } = setup('sub-1');
    routes.commands.accounts.mockRejectedValue(new Error('db down'));
    await expect(
      dispatch(message({ text: '/accounts' }), telegram, routes),
    ).rejects.toThrow('db down');
  });
});
