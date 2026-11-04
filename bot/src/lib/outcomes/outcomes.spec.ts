// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import {
  applyMigrationsForTest,
  createPgliteDataApiClient,
  type StatementOutcomeMessage,
} from 'shared';
import type { TelegramClient } from '../telegram';
import { formatOutcomeReport } from './formatReport';
import { reportOutcome } from './reportOutcome';

const config = { resourceArn: 'a', secretArn: 'b', database: 'c' };

let db: PGlite;
let client: ReturnType<typeof createPgliteDataApiClient>['client'];

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
  client = createPgliteDataApiClient(db, { role: 'draupnir_app' }).client;
}, 60_000);

afterAll(async () => {
  await db.close();
});

let n = 0;
// A file the bot handed to ingestion: its pending upload is bound to an S3 key.
async function botUpload(): Promise<string> {
  n += 1;
  const key = `uploads/alice/acc/${n}.csv`;
  await db.exec(`
    INSERT INTO bot_pending_uploads (user_id, chat_id, message_id, telegram_file_id, s3_key, expires_at)
      VALUES ('alice', 100, ${n}, 'tg', '${key}', now() + interval '1 hour')
  `);
  return key;
}

const message = (
  s3Key: string,
  over: Partial<StatementOutcomeMessage> = {},
): StatementOutcomeMessage => ({
  fileId: `file-${s3Key}`,
  s3Key,
  sub: 'alice',
  status: 'approved',
  reasons: [],
  warningsByAccount: {},
  newTransactionCount: 12,
  period: { from: '2026-01-01', to: '2026-01-31' },
  ...over,
});

function fakeTelegram() {
  const sendMessage = vi.fn().mockResolvedValue({});
  return {
    sendMessage,
    telegram: { sendMessage } as unknown as TelegramClient,
  };
}

const report = (m: StatementOutcomeMessage, telegram: TelegramClient) =>
  reportOutcome(m, { client, config, telegram });

const state = async (key: string) =>
  (
    await db.query<{ report_state: string }>(
      `SELECT report_state FROM bot_pending_uploads WHERE s3_key = $1`,
      [key],
    )
  ).rows[0]?.report_state;

describe('approved file report', () => {
  it('reports the new transactions, the period, and the gap warning', async () => {
    const key = await botUpload();
    const t = fakeTelegram();

    const result = await report(
      message(key, {
        warningsByAccount: {
          acc: [
            {
              code: 'gap-before',
              message:
                'The declared period starts after the earlier import’s period ends, leaving days uncovered',
            },
          ],
        },
      }),
      t.telegram,
    );

    expect(result).toBe('reported');
    expect(t.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = t.sendMessage.mock.calls[0] as [number, string];
    expect(chatId).toBe(100);
    expect(text).toContain('12 new transactions');
    expect(text).toContain('2026-01-01 to 2026-01-31');
    expect(text).toContain('leaving days uncovered');
    expect(await state(key)).toBe('reported');
  });
});

describe('rejected file report', () => {
  it('includes the row reason with expected and actual balances', async () => {
    const key = await botUpload();
    const t = fakeTelegram();

    await report(
      message(key, {
        status: 'rejected',
        newTransactionCount: 0,
        period: null,
        reasons: [
          {
            code: 'balance-chain',
            row: 37,
            message: 'Balance after row is 120.50 but expected 118.50',
          },
        ],
      }),
      t.telegram,
    );

    const text = t.sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toMatch(/rejected/i);
    expect(text).toContain(
      'Row 37: Balance after row is 120.50 but expected 118.50',
    );
  });
});

describe('delivery', () => {
  it('reports once when the same outcome is delivered twice', async () => {
    const key = await botUpload();
    const t = fakeTelegram();

    expect(await report(message(key), t.telegram)).toBe('reported');
    expect(await report(message(key), t.telegram)).toBe('skipped');

    expect(t.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reports exactly once when two workers receive it at the same time', async () => {
    const key = await botUpload();
    const t = fakeTelegram();

    const results = await Promise.all([
      report(message(key), t.telegram),
      report(message(key), t.telegram),
    ]);

    expect(results.sort()).toEqual(['reported', 'skipped']);
    expect(t.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('recovers a report whose sender died after claiming, once the lease lapses', async () => {
    const key = await botUpload();
    const crashed = fakeTelegram();
    crashed.sendMessage.mockRejectedValueOnce(new Error('worker died'));

    await expect(report(message(key), crashed.telegram)).rejects.toThrow(
      'worker died',
    );
    expect(await state(key)).toBe('claimed');

    // A redelivery inside the lease is dropped: the claimant may still finish.
    const early = fakeTelegram();
    expect(await report(message(key), early.telegram)).toBe('skipped');
    expect(early.sendMessage).not.toHaveBeenCalled();

    // After the lease, a later delivery sends it.
    await db.exec(
      `UPDATE bot_pending_uploads SET report_claimed_at = now() - interval '3 minutes' WHERE s3_key = '${key}'`,
    );
    const later = fakeTelegram();
    expect(await report(message(key), later.telegram)).toBe('reported');
    expect(later.sendMessage).toHaveBeenCalledTimes(1);
    expect(await state(key)).toBe('reported');
  });

  it('ignores an outcome for a file that did not come through the bot', async () => {
    const t = fakeTelegram();
    const result = await report(
      message('uploads/bob/acc/web-upload.csv'),
      t.telegram,
    );

    expect(result).toBe('skipped');
    expect(t.sendMessage).not.toHaveBeenCalled();
  });
});

describe('formatOutcomeReport', () => {
  const base = message('k');

  it('says so when nothing new was imported', () => {
    expect(formatOutcomeReport({ ...base, newTransactionCount: 0 })).toMatch(
      /No new transactions/,
    );
  });

  it('uses the singular for one transaction and omits an unknown period', () => {
    const text = formatOutcomeReport({
      ...base,
      newTransactionCount: 1,
      period: { from: null, to: null },
    });
    expect(text).toContain('1 new transaction imported.');
    expect(text).not.toContain('covering');
  });

  it('caps a long list of reasons and stays under Telegram’s limit', () => {
    const reasons = Array.from({ length: 5000 }, (_, i) => ({
      code: 'bad-row',
      row: i + 1,
      message: 'Amount is not a number '.repeat(3),
    }));
    const text = formatOutcomeReport({ ...base, status: 'rejected', reasons });

    expect(text).toContain('Row 15:');
    expect(text).not.toContain('Row 16:');
    expect(text).toContain('…and 4985 more.');
    expect(text.length).toBeLessThanOrEqual(4096);
  });
});
