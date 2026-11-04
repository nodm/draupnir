// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import type { CallbackQuery, Document, Message } from '@grammyjs/types';
import { applyMigrationsForTest, createPgliteDataApiClient } from 'shared';
import type { LinkedContext } from '../dispatcher';
import type { TelegramClient } from '../telegram';
import { isCsvDocument } from './files';
import {
  handleDocument,
  handleUploadCallback,
  type UploadDeps,
} from './handleUpload';
import { sebTitleIbans } from './sebHeader';

const config = { resourceArn: 'a', secretArn: 'b', database: 'c' };
const SEB_IBAN = 'LT100000000000000001';
const SEB_OTHER = 'LT100000000000000002';

let db: PGlite;
let deps: UploadDeps;
const s3Send = vi.fn();

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
  await db.exec(`
    INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
      ('seb1', 'seb', '${SEB_IBAN}', 'EUR', 'SEB main', '2024-01-01', 0),
      ('seb2', 'seb', '${SEB_OTHER}', 'EUR', 'SEB savings', '2024-01-01', 0),
      ('rev1', 'revolut', 'LT200000000000000001', 'EUR', 'Revolut EUR', '2024-01-01', 0),
      ('rev2', 'revolut', 'LT200000000000000002', 'USD', 'Revolut USD', '2024-01-01', 0),
      ('shared1', 'revolut', 'LT300000000000000001', 'EUR', 'Shared', '2024-01-01', 0);
    INSERT INTO account_members (account_id, user_id, role) VALUES
      ('seb1', 'alice', 'owner'), ('seb2', 'alice', 'owner'),
      ('rev1', 'bob', 'owner'), ('rev2', 'bob', 'owner'),
      ('shared1', 'carol', 'viewer'), ('shared1', 'bob', 'owner');
  `);
  const { client } = createPgliteDataApiClient(db, { role: 'draupnir_app' });
  deps = {
    client,
    config,
    s3: { send: s3Send } as never,
    bucket: 'uploads-bucket',
  };
}, 60_000);

afterAll(async () => {
  await db.close();
});

const REVOLUT_CSV =
  'Type,Product,Started Date\nCARD_PAYMENT,Current,2026-01-01\n';
const sebCsv = (iban: string) =>
  `"SĄSKAITOS  (${iban}) IŠRAŠAS (UŽ LAIKOTARPĮ: 2026-08-01-2026-08-31)";\n"DOK NR.";"DATA";\n`;

function fakeTelegram(content: string) {
  const sendMessage = vi.fn().mockResolvedValue({});
  const downloadFile = vi
    .fn()
    .mockResolvedValue(new TextEncoder().encode(content));
  const telegram = {
    sendMessage,
    getFile: vi.fn().mockResolvedValue({ file_path: 'documents/f.csv' }),
    downloadFile,
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelegramClient;
  return { telegram, sendMessage, downloadFile };
}

const ctxFor = (sub: string, telegram: TelegramClient): LinkedContext => ({
  update: {} as never,
  chatId: 100,
  telegramUserId: 100,
  telegram,
  sub,
});

const doc = (extra: Partial<Document> = {}): Document => ({
  file_id: 'tg-file',
  file_unique_id: 'u',
  file_name: 'statement.csv',
  mime_type: 'text/csv',
  file_size: 1000,
  ...extra,
});
const message = { message_id: 55 } as Message;

type PutInput = { Bucket: string; Key: string; Body: Uint8Array };
const stored = new Map<string, PutInput>();
// Objects that actually exist, i.e. successful writes only.
const puts = () => [...stored.values()];

const preconditionFailed = () =>
  Object.assign(new Error('At least one of the pre-conditions failed'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 },
  });

// Behaves like `If-None-Match: *`: a second write to a key is refused.
const fakePut = async (command: unknown) => {
  const input = (command as { input: PutInput }).input;
  if (stored.has(input.Key)) throw preconditionFailed();
  stored.set(input.Key, input);
  return {};
};

const pendingRows = async () =>
  (
    await db.query<{ id: string; s3_key: string | null }>(
      `SELECT id, s3_key FROM bot_pending_uploads`,
    )
  ).rows;

// Sends a document and returns the data of the button at `index`, if offered.
async function sendAndGetButtons(sub: string, content: string) {
  const t = fakeTelegram(content);
  await handleDocument(ctxFor(sub, t.telegram), message, doc(), deps);
  const markup = t.sendMessage.mock.calls[0]?.[2]?.replyMarkup;
  const buttons = (markup?.inline_keyboard ?? []).map(
    (row: { text: string; callback_data: string }[]) => row[0],
  );
  return { ...t, buttons };
}

async function press(
  sub: string,
  data: string,
  content: string,
  query: Partial<CallbackQuery> = {},
) {
  const t = fakeTelegram(content);
  await handleUploadCallback(
    ctxFor(sub, t.telegram),
    { id: 'q', message: { message_id: 9 }, ...query } as CallbackQuery,
    data,
    deps,
  );
  return t;
}

beforeEach(async () => {
  stored.clear();
  s3Send.mockReset();
  s3Send.mockImplementation(fakePut);
  await db.exec(`DELETE FROM bot_pending_uploads`);
});

describe('account chosen from buttons', () => {
  it('offers the owned accounts and hands the file to ingestion for the chosen one', async () => {
    const { buttons, sendMessage } = await sendAndGetButtons(
      'bob',
      REVOLUT_CSV,
    );

    expect(buttons.map((b: { text: string }) => b.text)).toEqual([
      'Revolut EUR (…0001)',
      'Revolut USD (…0002)',
      'Shared (…0001)',
    ]);
    expect(puts()).toEqual([]); // nothing uploaded before a choice
    expect(sendMessage.mock.calls[0]?.[1]).toMatch(/Which account/);

    const t = await press('bob', buttons[1].callback_data, REVOLUT_CSV);

    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ Bucket: 'uploads-bucket' });
    expect(puts()[0]?.Key).toMatch(/^uploads\/bob\/rev2\/[0-9a-f-]{36}\.csv$/);
    expect(Buffer.from(puts()[0]?.Body as Uint8Array).toString()).toBe(
      REVOLUT_CSV,
    );
    expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(
      /Importing into Revolut USD/,
    );
  });

  it('keeps button data within Telegram’s 64-byte limit', async () => {
    const { buttons } = await sendAndGetButtons('bob', REVOLUT_CSV);
    for (const b of buttons) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
  });

  it('removes the buttons once pressed', async () => {
    const { buttons } = await sendAndGetButtons('bob', REVOLUT_CSV);
    const t = await press('bob', buttons[0].callback_data, REVOLUT_CSV);
    expect(t.telegram.editMessageReplyMarkup).toHaveBeenCalledWith(100, 9);
  });

  it('imports once when the same button is pressed twice, and does not announce it twice', async () => {
    const { buttons } = await sendAndGetButtons('bob', REVOLUT_CSV);
    const first = await press('bob', buttons[0].callback_data, REVOLUT_CSV);
    const second = await press('bob', buttons[0].callback_data, REVOLUT_CSV);

    expect(puts()).toHaveLength(1);
    expect(first.sendMessage).toHaveBeenCalledTimes(1);
    expect(second.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a second press for a different account', async () => {
    const { buttons } = await sendAndGetButtons('bob', REVOLUT_CSV);
    await press('bob', buttons[0].callback_data, REVOLUT_CSV);
    const second = await press('bob', buttons[1].callback_data, REVOLUT_CSV);

    expect(puts()).toHaveLength(1);
    expect(second.sendMessage.mock.calls[0]?.[1]).toMatch(
      /already handled with a different account/,
    );
  });

  it('refuses a pending choice older than 1 hour', async () => {
    const { buttons } = await sendAndGetButtons('bob', REVOLUT_CSV);
    await db.exec(
      `UPDATE bot_pending_uploads SET expires_at = now() - interval '1 second'`,
    );

    const t = await press('bob', buttons[0].callback_data, REVOLUT_CSV);

    expect(puts()).toEqual([]);
    expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(/expired/);
  });

  it('refuses another user’s pending upload', async () => {
    const { buttons } = await sendAndGetButtons('bob', REVOLUT_CSV);

    const t = await press('alice', buttons[0].callback_data, REVOLUT_CSV);

    expect(puts()).toEqual([]);
    expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(
      /expired|no longer available/,
    );
  });

  it('refuses an account the user stopped owning after the buttons were shown', async () => {
    // A throwaway account with a second owner, so bob can be demoted (the
    // database refuses to remove an account's last owner).
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
        VALUES ('tmp1', 'revolut', 'LT400000000000000001', 'EUR', 'Temp account', '2024-01-01', 0);
      INSERT INTO account_members (account_id, user_id, role) VALUES
        ('tmp1', 'bob', 'owner'), ('tmp1', 'dave', 'owner');
    `);
    try {
      const { buttons } = await sendAndGetButtons('bob', REVOLUT_CSV);
      const temp = buttons.find((b: { text: string }) =>
        b.text.startsWith('Temp'),
      );
      await db.exec(
        `UPDATE account_members SET role = 'viewer' WHERE account_id = 'tmp1' AND user_id = 'bob'`,
      );

      const t = await press('bob', temp.callback_data, REVOLUT_CSV);

      expect(puts()).toEqual([]);
      expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(/no longer available/);
    } finally {
      // The last-owner trigger would block removing the remaining owner.
      await db.exec(`
        ALTER TABLE account_members DISABLE TRIGGER account_members_keep_last_owner;
        DELETE FROM account_members WHERE account_id = 'tmp1';
        ALTER TABLE account_members ENABLE TRIGGER account_members_keep_last_owner;
        DELETE FROM accounts WHERE id = 'tmp1';
      `);
    }
  });

  it('keeps the bound pending upload when S3 fails, and a retry completes it', async () => {
    const { buttons } = await sendAndGetButtons('bob', REVOLUT_CSV);
    s3Send.mockRejectedValueOnce(new Error('s3 down'));

    await expect(
      press('bob', buttons[2].callback_data, REVOLUT_CSV),
    ).rejects.toThrow('s3 down');
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.s3_key).toMatch(/^uploads\/bob\/shared1\//);

    const retry = await press('bob', buttons[2].callback_data, REVOLUT_CSV);

    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.Key).toBe(rows[0]?.s3_key);
    expect(retry.sendMessage.mock.calls[0]?.[1]).toMatch(/Importing/);
  });

  it('does not upload twice when PutObject threw after S3 had accepted the object', async () => {
    const { buttons } = await sendAndGetButtons('bob', REVOLUT_CSV);
    // a timeout that happens after the write
    s3Send.mockImplementationOnce(async (command: unknown) => {
      await fakePut(command);
      throw new Error('socket timeout');
    });

    await expect(
      press('bob', buttons[0].callback_data, REVOLUT_CSV),
    ).rejects.toThrow('socket timeout');
    await press('bob', buttons[0].callback_data, REVOLUT_CSV);

    expect(puts()).toHaveLength(1);
    expect(await pendingRows()).toHaveLength(1);
  });
});

describe('SEB file auto-selects its account', () => {
  it('imports without asking when the title IBAN matches exactly one owned account', async () => {
    const t = fakeTelegram(sebCsv(SEB_IBAN));
    await handleDocument(ctxFor('alice', t.telegram), message, doc(), deps);

    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.Key).toMatch(
      /^uploads\/alice\/seb1\/[0-9a-f-]{36}\.csv$/,
    );
    expect(t.sendMessage).toHaveBeenCalledTimes(1);
    expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(/Importing into SEB main/);
    expect(t.sendMessage.mock.calls[0]?.[2]).toBeUndefined(); // no buttons
  });

  it('a retried update after a failed acknowledgement uploads and records nothing twice', async () => {
    const t = fakeTelegram(sebCsv(SEB_IBAN));
    t.sendMessage.mockRejectedValueOnce(new Error('telegram down'));

    await expect(
      handleDocument(ctxFor('alice', t.telegram), message, doc(), deps),
    ).rejects.toThrow('telegram down');
    // the worker retries the same update
    await handleDocument(ctxFor('alice', t.telegram), message, doc(), deps);

    expect(puts()).toHaveLength(1);
    expect(await pendingRows()).toHaveLength(1);
  });

  it('uses the same key for the same message and a different one for another message', async () => {
    const send = async (messageId: number) => {
      const t = fakeTelegram(sebCsv(SEB_IBAN));
      await handleDocument(
        ctxFor('alice', t.telegram),
        { message_id: messageId } as Message,
        doc(),
        deps,
      );
    };
    await send(1);
    await send(1);
    await send(2);

    const keys = puts().map((p) => p.Key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(key).toMatch(/^uploads\/alice\/seb1\/[0-9a-f-]{36}\.csv$/);
    }
  });

  it('asks when the title IBAN is not one of the user’s accounts', async () => {
    const { buttons } = await sendAndGetButtons(
      'alice',
      sebCsv('LT999999999999999999'),
    );
    expect(buttons).toHaveLength(2);
    expect(puts()).toEqual([]);
  });

  it('asks when the file names more than one owned account', async () => {
    const both = sebCsv(SEB_IBAN) + sebCsv(SEB_OTHER);
    const { buttons } = await sendAndGetButtons('alice', both);
    expect(buttons).toHaveLength(2);
    expect(puts()).toEqual([]);
  });

  it('does not auto-select a non-SEB account whose IBAN appears in a SEB title', async () => {
    // bob owns revolut accounts only; a SEB-looking file must still ask.
    const { buttons } = await sendAndGetButtons(
      'bob',
      sebCsv('LT200000000000000001'),
    );
    expect(buttons.length).toBeGreaterThan(0);
    expect(puts()).toEqual([]);
  });
});

describe('who may upload', () => {
  it('refuses a viewer-only user and explains why', async () => {
    const t = fakeTelegram(REVOLUT_CSV);
    await handleDocument(ctxFor('carol', t.telegram), message, doc(), deps);

    expect(puts()).toEqual([]);
    expect(t.downloadFile).not.toHaveBeenCalled();
    expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(/owner has to import/);
  });

  it('points a user with no accounts at /newaccount', async () => {
    const t = fakeTelegram(REVOLUT_CSV);
    await handleDocument(ctxFor('nobody', t.telegram), message, doc(), deps);

    expect(puts()).toEqual([]);
    expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(/\/newaccount/);
  });
});

describe('what is accepted', () => {
  it('refuses a PDF and says only CSV is supported', async () => {
    const t = fakeTelegram('%PDF');
    await handleDocument(
      ctxFor('bob', t.telegram),
      message,
      doc({ file_name: 'statement.pdf', mime_type: 'application/pdf' }),
      deps,
    );

    expect(puts()).toEqual([]);
    expect(t.downloadFile).not.toHaveBeenCalled();
    expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(/Only CSV/);
  });

  it('refuses a file over the size limit without downloading it', async () => {
    const t = fakeTelegram(REVOLUT_CSV);
    await handleDocument(
      ctxFor('bob', t.telegram),
      message,
      doc({ file_size: 11 * 1024 * 1024 }),
      deps,
    );

    expect(t.downloadFile).not.toHaveBeenCalled();
    expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(/larger than 10 MB/);
  });

  it('refuses a download that turns out larger than the limit', async () => {
    const t = fakeTelegram('x'.repeat(10 * 1024 * 1024 + 1));
    await handleDocument(
      ctxFor('bob', t.telegram),
      message,
      doc({ file_size: undefined }),
      deps,
    );

    expect(puts()).toEqual([]);
    expect(t.sendMessage.mock.calls[0]?.[1]).toMatch(/could not read/);
  });

  it.each([
    [{ file_name: 'x.CSV', mime_type: 'application/octet-stream' }, true],
    [{ file_name: 'export', mime_type: 'text/csv' }, true],
    [{ file_name: 'export', mime_type: 'application/vnd.ms-excel' }, true],
    [
      { file_name: 'x.xlsx', mime_type: 'application/vnd.openxmlformats' },
      false,
    ],
    [{ file_name: undefined, mime_type: undefined }, false],
  ])('isCsvDocument(%j) = %s', (extra, expected) => {
    expect(isCsvDocument(doc(extra as Partial<Document>))).toBe(expected);
  });
});

describe('sebTitleIbans', () => {
  it('reads every account block title once, in order', () => {
    expect(
      sebTitleIbans(sebCsv('LT1') + sebCsv('LT2') + sebCsv('LT1')),
    ).toEqual(['LT1', 'LT2']);
  });

  it('is empty for other banks’ files', () => {
    expect(sebTitleIbans(REVOLUT_CSV)).toEqual([]);
  });
});
