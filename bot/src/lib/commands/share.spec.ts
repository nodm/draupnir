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
import { memberChatId } from '../sharing';
import {
  createShareHandler,
  createUnshareHandler,
  handleSharingCallback,
  handleSharingText,
} from './share';

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
  dan: 'dan@example.com',
};
const directory: UserDirectory = {
  findByEmail: async (email) => {
    const sub = Object.keys(EMAILS).find((s) => EMAILS[s] === email);
    return sub ? { sub, email } : null;
  },
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

// TRUNCATE skips the last-owner trigger, so every test starts from nothing.
beforeEach(async () => {
  await db.exec(
    'TRUNCATE accounts, account_members, messenger_links, bot_conversations CASCADE',
  );
});

afterAll(async () => {
  await db.close();
});

let n = 0;
// A fresh set of accounts per test: `owner` owns two (so the account chooser
// appears) and `solo` owns one. Returns ids.
async function world(owner: string, opts: { second?: boolean } = {}) {
  const k = ++n;
  const ids = { a: `a${k}`, b: `b${k}` };
  const ibanA = `LT${String(k).padStart(18, '0')}`;
  const ibanB = `LT9${String(k).padStart(17, '0')}`;
  await db.exec(`
    INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
      ('${ids.a}', 'seb', '${ibanA}', 'EUR', 'Main ${k}', '2026-01-01', 0)
      ${opts.second === false ? '' : `, ('${ids.b}', 'seb', '${ibanB}', 'EUR', 'Second ${k}', '2026-01-01', 0)`};
    INSERT INTO account_members (account_id, user_id, role) VALUES ('${ids.a}', '${owner}', 'owner')
      ${opts.second === false ? '' : `, ('${ids.b}', '${owner}', 'owner')`};
  `);
  return ids;
}

const members = async (accountId: string) =>
  (
    await db.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM account_members WHERE account_id = $1 ORDER BY user_id`,
      [accountId],
    )
  ).rows;

// One user's chat, as the worker would see it.
function user(sub: string, opts: { failSendTo?: number } = {}) {
  const sendMessage = vi.fn(async (chatId: number) => {
    if (chatId === opts.failSendTo) throw new Error('blocked');
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
  const own = () => to(1);
  const lastText = () => own().at(-1)?.[1] as string;
  const lastMarkup = () =>
    (own().at(-1) as unknown[])?.[2] as
      | {
          replyMarkup: {
            inline_keyboard: { text: string; callback_data: string }[][];
          };
        }
      | undefined;
  const button = (needle: string): string => {
    const found = lastMarkup()
      ?.replyMarkup.inline_keyboard.flat()
      .find(
        (b) =>
          b.text.includes(needle) || b.callback_data.endsWith(`:${needle}`),
      );
    if (!found) throw new Error(`no button ${needle}`);
    return found.callback_data;
  };
  return {
    ctx,
    sendMessage,
    editMessageReplyMarkup,
    to,
    lastText,
    button,
    share: () => createShareHandler(deps)(ctx, ''),
    unshare: () => createUnshareHandler(deps)(ctx, ''),
    say: (text: string) => handleSharingText(ctx, text, deps),
    press: (data: string) => handleSharingCallback(ctx, query, data, deps),
  };
}

const link = (sub: string, telegramUserId: number) =>
  db.exec(
    `INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (${telegramUserId}, '${sub}', '${EMAILS[sub]}') ON CONFLICT DO NOTHING`,
  );

describe('/share', () => {
  it('lets an owner share an account as viewer, and tells the user in their own chat', async () => {
    const ids = await world('alice');
    await link('bob', 2201);
    const alice = user('alice');
    await alice.share();
    await alice.press(alice.button(`Main`));
    await alice.say('Bob@Example.com '); // case and spaces do not matter
    await alice.press(alice.button('viewer'));

    expect(await members(ids.a)).toEqual([
      { user_id: 'alice', role: 'owner' },
      { user_id: 'bob', role: 'viewer' },
    ]);
    expect(await members(ids.b)).toEqual([{ user_id: 'alice', role: 'owner' }]);
    expect(alice.lastText()).toMatch(/bob@example.com now has viewer access/);
    expect(alice.lastText()).toMatch(/notified/);
    const told = alice.to(2201);
    expect(told).toHaveLength(1);
    expect(told[0]?.[1]).toMatch(
      /alice@example.com shared Main \d+ .* with you as viewer/,
    );
  });

  it('can share as owner', async () => {
    const ids = await world('alice', { second: false });
    const alice = user('alice');
    await alice.share(); // one account: no chooser, straight to the email
    expect(alice.lastText()).toMatch(/email/i);
    await alice.say('carol@example.com');
    await alice.press(alice.button('owner'));

    expect(await members(ids.a)).toContainEqual({
      user_id: 'carol',
      role: 'owner',
    });
  });

  it('says nobody was notified when the user is not linked to Telegram, but still shares', async () => {
    const ids = await world('alice', { second: false });
    const alice = user('alice');
    await alice.share();
    await alice.say('dan@example.com');
    await alice.press(alice.button('viewer'));

    expect(await members(ids.a)).toContainEqual({
      user_id: 'dan',
      role: 'viewer',
    });
    expect(alice.lastText()).toMatch(/not linked to Telegram/);
  });

  it('keeps the share when the notification cannot be delivered', async () => {
    const ids = await world('alice', { second: false });
    await link('bob', 2201);
    const alice = user('alice', { failSendTo: 2201 });
    await alice.share();
    await alice.say('bob@example.com');
    await alice.press(alice.button('viewer'));

    expect(await members(ids.a)).toContainEqual({
      user_id: 'bob',
      role: 'viewer',
    });
    expect(alice.lastText()).toMatch(/could not be notified/);
  });

  it('refuses an email nobody registered with, creates nothing, and says to sign in first', async () => {
    const ids = await world('alice', { second: false });
    const alice = user('alice');
    await alice.share();
    await alice.say('stranger@example.com');

    expect(alice.lastText()).toMatch(/sign in to Draupnir first/);
    expect(await members(ids.a)).toEqual([{ user_id: 'alice', role: 'owner' }]);
    // the dialogue is still open: a valid email now works
    await alice.say('carol@example.com');
    expect(alice.lastText()).toMatch(/Which access/);
  });

  it.each(['not an email', 'a"b@example.com', 'a b@example.com', ''])(
    'rejects the malformed email %j without asking Cognito',
    async (bad) => {
      await world('alice', { second: false });
      const spy = vi.spyOn(directory, 'findByEmail');
      const alice = user('alice');
      await alice.share();
      await alice.say(bad);
      expect(alice.lastText()).toMatch(/does not look like an email/);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    },
  );

  it('refuses to share with oneself', async () => {
    await world('alice', { second: false });
    const alice = user('alice');
    await alice.share();
    await alice.say('alice@example.com');
    expect(alice.lastText()).toMatch(/your own email/);
  });

  it('says so when the person already has access, and changes nothing', async () => {
    const ids = await world('alice', { second: false });
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.a}', 'bob', 'viewer')`,
    );
    const alice = user('alice');
    await alice.share();
    await alice.say('bob@example.com');
    await alice.press(alice.button('owner'));

    expect(alice.lastText()).toMatch(/already has access/);
    expect(await members(ids.a)).toContainEqual({
      user_id: 'bob',
      role: 'viewer',
    });
  });

  it('is for owners: a viewer has nothing to share', async () => {
    const ids = await world('alice', { second: false });
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.a}', 'bob', 'viewer')`,
    );
    const bob = user('bob');
    await bob.share();
    expect(bob.lastText()).toMatch(/do not own any account/);
  });

  it('refuses when the owner lost ownership while the dialogue was open', async () => {
    const ids = await world('alice', { second: false });
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.a}', 'bob', 'owner')`,
    );
    const alice = user('alice');
    await alice.share();
    await alice.say('carol@example.com');
    const viewer = alice.button('viewer');
    await db.exec(
      `UPDATE account_members SET role = 'viewer' WHERE user_id = 'alice' AND account_id = '${ids.a}'`,
    );
    await alice.press(viewer);

    expect(alice.lastText()).toMatch(/not an owner/);
    expect((await members(ids.a)).map((m) => m.user_id)).not.toContain('carol');
  });

  it('refuses buttons of an earlier /share once it is started again', async () => {
    const ids = await world('alice');
    const alice = user('alice');
    await alice.share();
    const old = alice.button('Main');
    await alice.share();
    await alice.press(old);

    expect(alice.lastText()).toMatch(/expired/);
    expect(await members(ids.a)).toHaveLength(1);
  });

  it('spends the buttons it was answered with', async () => {
    await world('alice');
    const alice = user('alice');
    await alice.share();
    await alice.press(alice.button('Main'));
    expect(alice.editMessageReplyMarkup).toHaveBeenCalledWith(1, 7);
  });

  it('while a button is awaited, typed text points back at the buttons; with no dialogue it falls through', async () => {
    await world('alice');
    const alice = user('alice');
    expect(await alice.say('hello')).toBe(false);
    await alice.share();
    expect(await alice.say('bob@example.com')).toBe(true);
    expect(alice.lastText()).toMatch(/use the buttons/i);
  });

  it('an invalid email keeps the dialogue alive (idle expiry restarts)', async () => {
    await world('alice', { second: false });
    const alice = user('alice');
    await alice.share();
    await db.exec(
      `UPDATE bot_conversations SET expires_at = now() + interval '1 minute' WHERE user_id = 'alice'`,
    );
    await alice.say('nope');
    const { rows } = await db.query<{ left: number }>(
      `SELECT extract(epoch FROM expires_at - now()) AS left FROM bot_conversations WHERE user_id = 'alice'`,
    );
    expect(Number(rows[0]?.left)).toBeGreaterThan(30 * 60);
  });
});

describe('/unshare', () => {
  it('removes a member and tells them in their own chat', async () => {
    const ids = await world('alice', { second: false });
    await link('bob', 2201);
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.a}', 'bob', 'viewer')`,
    );
    const alice = user('alice');
    await alice.unshare();
    await alice.press(alice.button('bob@example.com'));

    expect(await members(ids.a)).toEqual([{ user_id: 'alice', role: 'owner' }]);
    expect(alice.lastText()).toMatch(/bob@example.com no longer has access/);
    expect(alice.to(2201).at(-1)?.[1]).toMatch(
      /alice@example.com removed your access/,
    );
  });

  it('refuses to remove the only owner and leaves the membership unchanged', async () => {
    const ids = await world('alice', { second: false });
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.a}', 'bob', 'viewer')`,
    );
    const alice = user('alice');
    await alice.unshare();
    const bobButton = alice.button('bob@example.com');
    await alice.press(alice.button('You'));

    expect(alice.lastText()).toMatch(/at least one owner/);
    expect(await members(ids.a)).toEqual([
      { user_id: 'alice', role: 'owner' },
      { user_id: 'bob', role: 'viewer' },
    ]);
    // the list stays usable: another member can still be picked
    await alice.press(bobButton);
    expect(await members(ids.a)).toEqual([{ user_id: 'alice', role: 'owner' }]);
  });

  it('lets an owner remove themselves when another owner remains', async () => {
    const ids = await world('alice', { second: false });
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.a}', 'bob', 'owner')`,
    );
    const alice = user('alice');
    await alice.unshare();
    await alice.press(alice.button('You'));

    expect(await members(ids.a)).toEqual([{ user_id: 'bob', role: 'owner' }]);
    expect(alice.lastText()).toMatch(/You no longer have access/);
  });

  it('asks which account first when the owner has several', async () => {
    const ids = await world('alice');
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.b}', 'carol', 'viewer')`,
    );
    const alice = user('alice');
    await alice.unshare();
    await alice.press(alice.button('Second'));
    await alice.press(alice.button('carol@example.com'));

    expect(await members(ids.b)).toEqual([{ user_id: 'alice', role: 'owner' }]);
    expect(alice.editMessageReplyMarkup).toHaveBeenCalled();
  });

  it('is for owners: a viewer cannot remove anyone', async () => {
    const ids = await world('alice', { second: false });
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.a}', 'bob', 'viewer')`,
    );
    const bob = user('bob');
    await bob.unshare();
    expect(bob.lastText()).toMatch(/do not own any account/);
  });

  it('refuses buttons of an earlier /unshare', async () => {
    const ids = await world('alice');
    const alice = user('alice');
    await alice.unshare();
    const old = alice.button('Main');
    await alice.unshare();
    await alice.press(old);
    expect(alice.lastText()).toMatch(/expired/);
    expect(await members(ids.a)).toHaveLength(1);
  });

  it('a removed member cannot be removed twice', async () => {
    const ids = await world('alice', { second: false });
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.a}', 'bob', 'viewer')`,
    );
    const alice = user('alice');
    await alice.unshare();
    const bobButton = alice.button('bob@example.com');
    await db.exec(
      `DELETE FROM account_members WHERE user_id = 'bob' AND account_id = '${ids.a}'`,
    );
    await alice.press(bobButton);
    expect(alice.lastText()).toMatch(/no longer has access/);
  });
});

describe('memberChatId', () => {
  it('answers only to an owner, and only for a member of that account', async () => {
    const ids = await world('alice', { second: false });
    await link('bob', 2201);
    await link('carol', 2202);
    await db.exec(
      `INSERT INTO account_members VALUES ('${ids.a}', 'bob', 'viewer')`,
    );
    const ask = (caller: string, account: string, target: string) =>
      memberChatId(deps.client, deps.config, caller, account, target);

    expect(await ask('alice', ids.a, 'bob')).toBe(2201);
    expect(await ask('bob', ids.a, 'bob')).toBeNull(); // a viewer learns nothing
    expect(await ask('alice', ids.a, 'carol')).toBeNull(); // linked, but not a member
    expect(await ask('dan', ids.a, 'bob')).toBeNull(); // not a member at all
  });
});
