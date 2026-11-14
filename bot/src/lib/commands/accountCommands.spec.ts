// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import type { CallbackQuery } from '@grammyjs/types';
import { applyMigrationsForTest, createPgliteDataApiClient } from 'shared';
import type { LinkedContext } from '../dispatcher';
import type { TelegramClient } from '../telegram';
import {
  createAccountsHandler,
  createCoverageHandler,
  handleCoverageCallback,
} from './accounts';
import {
  createCancelHandler,
  createNewAccountHandler,
  handleNewAccountCallback,
  handleNewAccountText,
} from './newAccount';

const config = { resourceArn: 'a', secretArn: 'b', database: 'c' };
const VALID_IBAN = 'LT121000011101001000';
const NOW = new Date('2026-06-15T10:00:00Z');

let db: PGlite;
let deps: {
  client: ReturnType<typeof createPgliteDataApiClient>['client'];
  config: typeof config;
  now: () => Date;
};

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
  deps = {
    client: createPgliteDataApiClient(db, { role: 'draupnir_app' }).client,
    config,
    now: () => NOW,
  };
  await db.exec(`
    INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
      ('own', 'seb', 'LT100000000000000001', 'EUR', 'SEB main', '2026-01-01', 0),
      ('shared', 'revolut', 'LT200000000000000002', 'EUR', 'Joint', '2026-01-01', 0),
      ('other', 'seb', 'LT300000000000000003', 'EUR', 'Not mine', '2026-01-01', 0),
      ('gappy', 'seb', 'LT400000000000000004', 'EUR', 'Gappy', '2026-01-01', 0),
      ('empty', 'seb', 'LT500000000000000005', 'EUR', 'Empty', '2026-01-01', 0);
    INSERT INTO account_members (account_id, user_id, role) VALUES
      ('own', 'alice', 'owner'), ('shared', 'alice', 'viewer'), ('shared', 'bob', 'owner'),
      ('other', 'bob', 'owner'), ('gappy', 'carol', 'owner'), ('empty', 'dave', 'owner');
    INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status) VALUES
      ('f1', 'own', 'alice', 'seb', 'h1', 'k1', 'approved'),
      ('g1', 'gappy', 'carol', 'seb', 'h2', 'k2', 'approved'),
      ('g2', 'gappy', 'carol', 'seb', 'h3', 'k3', 'approved');
    INSERT INTO statement_file_accounts (file_id, account_id, declared_from, declared_to, activity_from, activity_to) VALUES
      ('f1', 'own', '2026-01-01', '2026-03-31', '2026-01-05', '2026-03-30'),
      ('g1', 'gappy', '2026-01-01', '2026-01-31', '2026-01-05', '2026-01-27'),
      ('g2', 'gappy', '2026-03-01', '2026-03-31', '2026-03-02', '2026-03-30');
  `);
}, 60_000);

afterAll(async () => {
  await db.close();
});

function chat(sub: string) {
  const sendMessage = vi.fn().mockResolvedValue({});
  const editMessageReplyMarkup = vi.fn().mockResolvedValue(undefined);
  const telegram = {
    sendMessage,
    editMessageReplyMarkup,
  } as unknown as TelegramClient;
  const ctx: LinkedContext = {
    update: {} as never,
    chatId: 1,
    telegramUserId: 1,
    telegram,
    sub,
  };
  const lastText = () => sendMessage.mock.calls.at(-1)?.[1] as string;
  const lastOptions = () => sendMessage.mock.calls.at(-1)?.[2];
  const lastMarkup = () => sendMessage.mock.calls.at(-1)?.[2]?.replyMarkup;
  return {
    ctx,
    sendMessage,
    editMessageReplyMarkup,
    lastText,
    lastOptions,
    lastMarkup,
  };
}

const query = { id: 'q', message: { message_id: 7 } } as CallbackQuery;

describe('/accounts', () => {
  it('lists owned and shared accounts with roles and no other account', async () => {
    const t = chat('alice');
    await createAccountsHandler(deps)(t.ctx, '');

    const text = t.lastText();
    expect(text).toMatch(/<b>\d\. SEB main<\/b> \(owner\)/);
    expect(text).toContain('SEB · <code>…0001</code> · EUR');
    expect(text).toContain('Revolut · <code>…0002</code> · EUR');
    expect(text).toContain('(viewer)');
    expect(t.lastOptions()).toEqual({ parseMode: 'HTML' });
    expect(text).not.toContain('Not mine');
    expect(text).not.toContain('LT1000'); // never the full IBAN
  });

  it('shows the reconciled-up-to date, or that it is not reconciled yet', async () => {
    const t = chat('alice');
    await createAccountsHandler(deps)(t.ctx, '');
    expect(t.lastText()).toContain('Reconciled up to <code>2026-03-31</code>');
    expect(t.lastText()).toContain('Not reconciled yet'); // Joint: nothing imported
  });

  it('points a user with no accounts at /newaccount', async () => {
    const t = chat('nobody');
    await createAccountsHandler(deps)(t.ctx, '');
    expect(t.lastText()).toMatch(/\/newaccount/);
    expect(t.lastOptions()).toBeUndefined();
  });
});

describe('/coverage', () => {
  it('lists both periods and February as a gap when January and March are imported', async () => {
    const t = chat('carol');
    await createCoverageHandler(deps)(t.ctx, '');

    const text = t.lastText();
    expect(text).toContain('<code>2026-01-01 to 2026-01-31</code>');
    expect(text).toContain('<code>2026-03-01 to 2026-03-31</code>');
    expect(text).toContain('<b>Gaps</b>');
    expect(text).toContain('<code>2026-02-01 to 2026-02-28</code>');
    expect(text).toContain('Reconciled up to <code>2026-01-31</code>');
    expect(t.lastOptions()).toEqual({ parseMode: 'HTML' });
  });

  it('says so when nothing has been imported', async () => {
    const t = chat('dave');
    await createCoverageHandler(deps)(t.ctx, '');
    expect(t.lastText()).toContain('Nothing has been imported yet');
  });

  it('asks which account when there are several, with buttons that fit Telegram’s limit', async () => {
    const t = chat('alice');
    await createCoverageHandler(deps)(t.ctx, '');

    const buttons = t.lastMarkup().inline_keyboard.map((r: unknown[]) => r[0]);
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }

    expect(t.lastOptions()).not.toHaveProperty('parseMode'); // the chooser
    await handleCoverageCallback(t.ctx, query, buttons[0].callback_data, deps);
    expect(t.lastText()).toContain('Coverage of');
    expect(t.lastOptions()).toEqual({ parseMode: 'HTML' });
    expect(t.editMessageReplyMarkup).toHaveBeenCalledWith(1, 7); // chooser spent
  });

  it('refuses the coverage of an account the user is not a member of', async () => {
    const t = chat('alice');
    await handleCoverageCallback(t.ctx, query, 'cov:other', deps);
    expect(t.lastText()).toMatch(/not available/);
    expect(t.lastOptions()).toBeUndefined();
    expect(t.lastText()).not.toContain('Not mine');
  });

  it('points a user with no accounts at /newaccount', async () => {
    const t = chat('nobody');
    await createCoverageHandler(deps)(t.ctx, '');
    expect(t.lastText()).toMatch(/\/newaccount/);
  });
});

// A whole dialogue as the user would drive it.
function dialogue(sub: string) {
  const t = chat(sub);
  const say = (text: string) => handleNewAccountText(t.ctx, text, deps);
  const press = (data: string) =>
    handleNewAccountCallback(t.ctx, query, data, deps);
  const start = () => createNewAccountHandler(deps)(t.ctx, '');
  // callback_data of the button on the last prompt whose data ends with suffix
  const button = (suffix: string): string => {
    const found = (
      t.lastMarkup().inline_keyboard as { callback_data: string }[][]
    )
      .flat()
      .find((b) => b.callback_data.endsWith(`:${suffix}`));
    if (!found) throw new Error(`no button ${suffix}`);
    return found.callback_data;
  };
  const fillUpToConfirm = async (iban = VALID_IBAN) => {
    await start();
    await press(button('seb'));
    await say(iban);
    await say('eur');
    await say('Savings');
    await say('2026-01-31');
    await say('1250,50');
  };
  return { ...t, say, press, start, button, fillUpToConfirm };
}

const accountRow = async (iban: string) =>
  (
    await db.query<{
      id: string;
      display_name: string;
      currency: string;
      opened_on: string;
      opening_balance_minor_units: string;
    }>(`SELECT * FROM accounts WHERE iban = $1`, [iban])
  ).rows[0];

describe('/newaccount', () => {
  it('creates the account with those values and makes the user its owner', async () => {
    const d = dialogue('erin');
    await d.fillUpToConfirm();
    expect(d.lastText()).toContain('Create this account?');
    expect(d.lastText()).toContain('Balance on 2026-01-31: 1250.50 EUR');
    expect(d.lastText()).not.toContain(VALID_IBAN); // masked in the summary

    await d.press(d.button('yes'));

    const row = await accountRow(VALID_IBAN);
    expect(row).toMatchObject({
      display_name: 'Savings',
      currency: 'EUR',
      opening_balance_minor_units: 125050,
    });
    const member = await db.query(
      `SELECT role FROM account_members WHERE account_id = $1 AND user_id = 'erin'`,
      [row?.id],
    );
    expect(member.rows).toEqual([{ role: 'owner' }]);
    expect(d.lastText()).toMatch(/Created Savings/);
  });

  it('asks again for an IBAN with a wrong checksum, without advancing', async () => {
    const d = dialogue('frank');
    await d.start();
    await d.press(d.button('revolut'));

    await d.say('LT121000011101001001'); // bad checksum
    expect(d.lastText()).toMatch(/not a valid IBAN/);

    // still on the IBAN step: a valid IBAN is accepted and moves on
    await d.say('LT601010012345678901');
    expect(d.lastText()).toMatch(/currency/i);
  });

  it('refuses to create a second account for an existing IBAN and explains how to get access', async () => {
    const taken = 'LT601010012345678901'; // created in the previous test? make sure
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
        VALUES ('taken', 'seb', '${taken}', 'EUR', 'Taken', '2026-01-01', 0)
        ON CONFLICT DO NOTHING
    `);
    const d = dialogue('gina');
    await d.fillUpToConfirm(taken);
    await d.press(d.button('yes'));

    expect(d.lastText()).toMatch(/already exists/);
    expect(d.lastText()).toMatch(/\/share/);
    const count = await db.query(
      `SELECT 1 FROM account_members WHERE user_id = 'gina'`,
    );
    expect(count.rows).toEqual([]);
  });

  describe('per-step validation', () => {
    async function atStep(step: 'currency' | 'name' | 'openedOn' | 'balance') {
      const d = dialogue(`val-${step}`);
      await d.start();
      await d.press(d.button('seb'));
      await d.say('LT331010012345678902');
      if (step === 'currency') return d;
      await d.say('EUR');
      if (step === 'name') return d;
      await d.say('Name');
      if (step === 'openedOn') return d;
      await d.say('2026-01-01');
      return d;
    }

    it.each(['EURO', 'E1R', '€', ''])(
      'rejects the currency %j',
      async (bad) => {
        const d = await atStep('currency');
        await d.say(bad);
        expect(d.lastText()).toMatch(/3-letter currency code/);
      },
    );

    it('rejects an over-long or empty name', async () => {
      const d = await atStep('name');
      await d.say('x'.repeat(61));
      expect(d.lastText()).toMatch(/up to 60 characters/);
    });

    it.each(['2026-02-30', '31.01.2026', 'yesterday'])(
      'rejects the date %j',
      async (bad) => {
        const d = await atStep('openedOn');
        await d.say(bad);
        expect(d.lastText()).toMatch(/real date/);
      },
    );

    it('rejects a date in the future but accepts today', async () => {
      const d = await atStep('openedOn');
      await d.say('2026-06-16');
      expect(d.lastText()).toMatch(/in the future/);
      await d.say('2026-06-15');
      expect(d.lastText()).toMatch(/balance/i);
    });

    it.each(['lots', '12.345', '1 000', ''])(
      'rejects the balance %j',
      async (bad) => {
        const d = await atStep('balance');
        await d.say(bad);
        expect(d.lastText()).toMatch(/number in EUR/);
      },
    );

    it('accepts a negative balance', async () => {
      const d = await atStep('balance');
      await d.say('-30');
      expect(d.lastText()).toContain('-30.00 EUR');
    });
  });

  describe('/cancel and expiry', () => {
    it('/cancel abandons the dialogue at any step', async () => {
      const d = dialogue('cancel-1');
      await d.start();
      await d.press(d.button('seb'));
      await d.say('LT331010012345678902');

      await createCancelHandler(deps)(d.ctx, '');
      expect(d.lastText()).toBe('Cancelled.');

      // later text is not an answer any more
      expect(await d.say('EUR')).toBe(false);
    });

    it('/cancel with nothing open says so', async () => {
      const d = dialogue('cancel-2');
      await createCancelHandler(deps)(d.ctx, '');
      expect(d.lastText()).toMatch(/nothing to cancel/);
    });

    it('the Cancel button creates nothing', async () => {
      const d = dialogue('cancel-3');
      await d.fillUpToConfirm('LT061010012345678903');
      await d.press(d.button('no'));

      expect(d.lastText()).toMatch(/No account was created/);
      expect(await accountRow('LT061010012345678903')).toBeUndefined();
    });

    it('an unfinished dialogue expires after an hour: text is no longer an answer', async () => {
      const d = dialogue('expire-1');
      await d.start();
      await db.exec(
        `UPDATE bot_conversations SET expires_at = now() - interval '1 second' WHERE user_id = 'expire-1'`,
      );

      expect(await d.say('LT331010012345678902')).toBe(false);
    });

    it('a button pressed after expiry asks to start again and creates nothing', async () => {
      const d = dialogue('expire-2');
      await d.fillUpToConfirm('LT761010012345678904');
      await db.exec(
        `UPDATE bot_conversations SET expires_at = now() - interval '1 second' WHERE user_id = 'expire-2'`,
      );

      await d.press(d.button('yes'));

      expect(d.lastText()).toMatch(/expired/);
      expect(await accountRow('LT761010012345678904')).toBeUndefined();
    });

    it('a stale button from an earlier step is refused', async () => {
      const d = dialogue('stale-1');
      await d.start();
      const banks = { seb: d.button('seb'), revolut: d.button('revolut') };
      await d.press(banks.seb);
      await d.press(banks.revolut); // the bank buttons are spent

      expect(d.lastText()).toMatch(/expired/);
    });

    it('starting /newaccount again restarts from the first question', async () => {
      const d = dialogue('restart-1');
      await d.start();
      await d.press(d.button('seb'));
      await d.start();
      expect(d.lastText()).toMatch(/Which bank/);
    });

    it('buttons of an earlier /newaccount are refused once it is started again', async () => {
      const d = dialogue('restart-2');
      await d.start();
      const old = d.button('revolut');
      await d.start();
      const current = d.button('seb');
      await d.press(old);

      expect(d.lastText()).toMatch(/expired/);
      // the new dialogue is untouched: its own buttons still work
      await d.press(current);
      expect(d.lastText()).toMatch(/IBAN/);
    });

    it('an invalid answer counts as activity and keeps the dialogue alive', async () => {
      const d = dialogue('idle-1');
      await d.start();
      await d.press(d.button('seb'));
      await db.exec(
        `UPDATE bot_conversations SET expires_at = now() + interval '1 minute' WHERE user_id = 'idle-1'`,
      );

      await d.say('not an iban');

      const { rows } = await db.query<{ left: number }>(
        `SELECT extract(epoch FROM expires_at - now()) AS left FROM bot_conversations WHERE user_id = 'idle-1'`,
      );
      expect(Number(rows[0]?.left)).toBeGreaterThan(30 * 60);
    });

    it('while a dialogue waits for a button, typed text is redirected to the buttons', async () => {
      const d = dialogue('buttons-1');
      await d.start();
      await d.say('seb');
      expect(d.lastText()).toMatch(/use the buttons/i);
    });

    it('spends the buttons it was answered with', async () => {
      const d = dialogue('spent-1');
      await d.start();
      await d.press(d.button('seb'));
      expect(d.editMessageReplyMarkup).toHaveBeenCalledWith(1, 7);
    });
  });

  it('keeps one dialogue per user', async () => {
    const a = dialogue('iso-a');
    const b = dialogue('iso-b');
    await a.start();
    await a.press(a.button('seb'));

    expect(await b.say('LT331010012345678902')).toBe(false);
  });
});
