import { PGlite } from '@electric-sql/pglite';
import type { CallbackQuery } from '@grammyjs/types';
import {
  applyMigrationsForTest,
  createPgliteDataApiClient,
  type DataApiConfig,
} from 'shared';
import type { UserDirectory } from '../directory';
import type { LinkedContext } from '../dispatcher';
import type { TelegramClient } from '../telegram';
import {
  createRenameHandler,
  handleRenameCallback,
  handleRenameText,
} from './renameAccount';

const config: DataApiConfig = {
  resourceArn: 'arn:cluster',
  secretArn: 'arn:secret',
  database: 'draupnir',
};
const query = { id: 'q', message: { message_id: 7 } } as CallbackQuery;

const EMAILS: Record<string, string> = {
  alice: 'alice@example.com',
  bob: 'bob@example.com',
  carol: 'carol@example.com',
};
const directory: UserDirectory = {
  findByEmail: async () => null,
  emailOf: async (sub) => EMAILS[sub] ?? null,
};

let db: PGlite;
let deps: {
  client: ReturnType<typeof createPgliteDataApiClient>['client'];
  config: DataApiConfig;
  directory: UserDirectory;
};

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
  deps = {
    client: createPgliteDataApiClient(db, { role: 'draupnir_app' }).client,
    config,
    directory,
  };
}, 60_000);

beforeEach(async () => {
  await db.exec(
    'TRUNCATE accounts, account_members, messenger_links, bot_conversations CASCADE',
  );
});

afterAll(async () => {
  await db.close();
});

// alice owns a1 (and a2 unless `second: false`); bob is a viewer of a1.
async function world(opts: { second?: boolean } = {}) {
  await db.exec(`
    INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
      ('a1', 'seb', 'LT000000000000000001', 'EUR', 'Main', '2026-01-01', 0)
      ${opts.second === false ? '' : `, ('a2', 'seb', 'LT000000000000000002', 'EUR', 'Second', '2026-01-01', 0)`};
    INSERT INTO account_members (account_id, user_id, role) VALUES
      ('a1', 'alice', 'owner'), ('a1', 'bob', 'viewer')
      ${opts.second === false ? '' : `, ('a2', 'alice', 'owner')`};
  `);
}

const nameOf = async (id: string) =>
  (
    await db.query<{ display_name: string }>(
      `SELECT display_name FROM accounts WHERE id = $1`,
      [id],
    )
  ).rows[0]?.display_name;

function user(sub: string, opts: { failSendTo?: number } = {}) {
  const sendMessage = vi.fn(async (...args: [number, string?, unknown?]) => {
    if (args[0] === opts.failSendTo) throw new Error('blocked');
    return {};
  });
  const editMessageReplyMarkup = vi.fn().mockResolvedValue(undefined);
  const ctx: LinkedContext = {
    update: {} as never,
    chatId: 1,
    telegramUserId: 1,
    telegram: {
      sendMessage,
      editMessageReplyMarkup,
    } as unknown as TelegramClient,
    sub,
  };
  const to = (chatId: number) =>
    sendMessage.mock.calls.filter((c) => c[0] === chatId);
  const lastText = () => to(1).at(-1)?.[1] as string;
  const button = (needle: string): string => {
    const markup = (to(1).at(-1) as unknown[])?.[2] as
      | {
          replyMarkup: {
            inline_keyboard: { text: string; callback_data: string }[][];
          };
        }
      | undefined;
    const found = markup?.replyMarkup.inline_keyboard
      .flat()
      .find((b) => b.text.includes(needle));
    if (!found) throw new Error(`no button ${needle}`);
    return found.callback_data;
  };
  return {
    ctx,
    to,
    lastText,
    button,
    rename: () => createRenameHandler(deps)(ctx, ''),
    say: (text: string) => handleRenameText(ctx, text, deps),
    press: (data: string) => handleRenameCallback(ctx, query, data, deps),
  };
}

const link = (sub: string, telegramUserId: number) =>
  db.exec(
    `INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (${telegramUserId}, '${sub}', '${EMAILS[sub]}')`,
  );

describe('/renameaccount', () => {
  it('still renames, and says so, when the member lookup fails', async () => {
    await world({ second: false });
    const real = deps.client;
    const failing = {
      ...deps,
      client: {
        send: (command: { input?: { sql?: string } }) =>
          command.input?.sql?.includes(
            'SELECT user_id, role FROM account_members',
          )
            ? Promise.reject(new Error('db down'))
            : real.send(command as never),
      } as unknown as typeof real,
    };
    const alice = user('alice');
    await createRenameHandler(failing)(alice.ctx, '');
    await handleRenameText(alice.ctx, 'Salary', failing);

    expect(await nameOf('a1')).toBe('Salary');
    expect(alice.lastText()).toMatch(/Renamed "Main" to "Salary"\./);
    expect(alice.lastText()).toMatch(/member lookup failed/);
  });

  it('lets an owner of several accounts pick one and rename it, telling a linked viewer', async () => {
    await world();
    await link('bob', 2201);
    const alice = user('alice');
    await alice.rename();
    await alice.press(alice.button('Main'));
    await alice.say(' Salary ');

    expect(await nameOf('a1')).toBe('Salary');
    expect(await nameOf('a2')).toBe('Second');
    expect(alice.lastText()).toMatch(/Renamed "Main" to "Salary"\./);
    expect(alice.lastText()).toMatch(/notified/);
    const told = alice.to(2201);
    expect(told).toHaveLength(1);
    expect(told[0]?.[1]).toBe(
      'alice@example.com renamed the account "Main" to "Salary".',
    );
  });

  it('skips the pick when the user owns exactly one account', async () => {
    await world({ second: false });
    const alice = user('alice');
    await alice.rename();
    expect(alice.lastText()).toMatch(/new name/i);
    await alice.say('Salary');
    expect(await nameOf('a1')).toBe('Salary');
  });

  it('does not message the renaming owner separately', async () => {
    await world({ second: false });
    await link('bob', 2201);
    await link('alice', 1);
    const alice = user('alice');
    await alice.rename();
    await alice.say('Salary');
    // chat 1 is alice's own: prompt + confirmation only, no notification
    expect(alice.to(1)).toHaveLength(2);
  });

  it('asks again for an invalid name without renaming', async () => {
    await world({ second: false });
    const alice = user('alice');
    await alice.rename();
    await alice.say('x'.repeat(61));
    expect(alice.lastText()).toMatch(/up to 60 characters/);
    expect(await nameOf('a1')).toBe('Main');
    await alice.say('Salary'); // dialogue is still open
    expect(await nameOf('a1')).toBe('Salary');
  });

  it('still renames when a member is not linked, and says nobody was notified', async () => {
    await world({ second: false });
    const alice = user('alice');
    await alice.rename();
    await alice.say('Salary');
    expect(await nameOf('a1')).toBe('Salary');
    expect(alice.lastText()).toMatch(/Nobody else could be notified/);
  });

  it('still renames when the message to a member fails', async () => {
    await world({ second: false });
    await link('bob', 2201);
    const alice = user('alice', { failSendTo: 2201 });
    await alice.rename();
    await alice.say('Salary');
    expect(await nameOf('a1')).toBe('Salary');
    expect(alice.lastText()).toMatch(/Nobody else could be notified/);
  });

  it('refuses a user who only views accounts', async () => {
    await world();
    const bob = user('bob');
    await bob.rename();
    expect(bob.lastText()).toMatch(/Only an owner can rename/);
    expect(await nameOf('a1')).toBe('Main');
    expect(await bob.say('Hacked')).toBe(false); // no dialogue was opened
  });

  it('renames nothing when ownership was lost mid-dialogue', async () => {
    await world({ second: false });
    const alice = user('alice');
    await alice.rename();
    await db.exec(
      `INSERT INTO account_members (account_id, user_id, role) VALUES ('a1', 'carol', 'owner');
       DELETE FROM account_members WHERE account_id = 'a1' AND user_id = 'alice'`,
    );
    await alice.say('Salary');
    expect(await nameOf('a1')).toBe('Main');
    expect(alice.lastText()).toMatch(/not an owner of that account any more/);
  });

  it('refuses buttons of an earlier dialogue', async () => {
    await world();
    const alice = user('alice');
    await alice.rename();
    const stale = alice.button('Main');
    await alice.rename(); // new nonce
    await alice.press(stale);
    expect(alice.lastText()).toMatch(/expired/);
  });

  it('is not a dialogue for free text when none is open', async () => {
    await world();
    expect(await user('alice').say('Salary')).toBe(false);
  });
});
