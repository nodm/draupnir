// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { executeStatement, withCaller, type DataApiConfig } from '../dataApi';
import { applyMigrationsForTest } from '../migrations/applyMigrationsForTest';
import { createPgliteDataApiClient } from '../testing/pgliteDataApiClient';
import {
  enqueueOutcome,
  publishCommittedOutcome,
  publishDueOutcomes,
} from './outbox';
import {
  boundOutcomeMessage,
  coveredPeriod,
  isOutcomeMessage,
  MAX_MESSAGE_REASONS,
  type StatementOutcomeMessage,
} from './outcomeMessage';

const config: DataApiConfig = {
  resourceArn: 'a',
  secretArn: 'b',
  database: 'c',
};
const QUEUE = 'https://sqs.example/outcomes';

let db: PGlite;
let client: ReturnType<typeof createPgliteDataApiClient>['client'];

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
  await db.exec(`
    INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
      VALUES ('acc', 'seb', 'IBAN', 'EUR', 'x', '2024-01-01', 0);
    INSERT INTO account_members (account_id, user_id, role) VALUES ('acc', 'alice', 'owner');
  `);
  client = createPgliteDataApiClient(db, { role: 'draupnir_app' }).client;
}, 60_000);

afterAll(async () => {
  await db.close();
});

let n = 0;
async function newFile(uploadedBy = 'alice'): Promise<StatementOutcomeMessage> {
  n += 1;
  await db.exec(`
    INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status)
      VALUES ('f${n}', 'acc', '${uploadedBy}', 'seb', 'h${n}', 'k${n}', 'approved')
  `);
  return {
    fileId: `f${n}`,
    s3Key: `k${n}`,
    sub: uploadedBy,
    status: 'approved',
    reasons: [],
    warningsByAccount: {},
    newTransactionCount: 3,
    period: { from: '2026-01-01', to: '2026-01-31' },
  };
}

const outboxRow = async (fileId: string) =>
  (
    await db.query<{ published_at: string | null; payload: unknown }>(
      `SELECT published_at, payload FROM statement_outcome_outbox WHERE file_id = $1`,
      [fileId],
    )
  ).rows[0];

const ageOutbox = (fileId: string, interval = '2 minutes') =>
  db.exec(
    `UPDATE statement_outcome_outbox SET created_at = now() - interval '${interval}' WHERE file_id = '${fileId}'`,
  );

const sqsThatWorks = () => {
  const sent: StatementOutcomeMessage[] = [];
  const send = vi.fn(async (command: unknown) => {
    sent.push(
      JSON.parse(
        (command as { input: { MessageBody: string } }).input.MessageBody,
      ),
    );
    return {};
  });
  return { sent, sqs: { send } as never };
};

describe('enqueueOutcome', () => {
  it('writes the outbox row in the outcome’s transaction', async () => {
    const message = await newFile();

    await withCaller(client, config, 'alice', (tx) =>
      enqueueOutcome(client, config, tx, message),
    );

    const row = await outboxRow(message.fileId as string);
    expect(row?.published_at).toBeNull();
    expect(row?.payload).toMatchObject({
      s3Key: message.s3Key,
      status: 'approved',
    });
  });

  it('leaves no row when the transaction rolls back', async () => {
    const message = await newFile();

    await expect(
      withCaller(client, config, 'alice', async (tx) => {
        await enqueueOutcome(client, config, tx, message);
        throw new Error('import failed');
      }),
    ).rejects.toThrow('import failed');

    expect(await outboxRow(message.fileId as string)).toBeUndefined();
  });

  it('refuses a file the caller did not upload', async () => {
    const message = await newFile('alice');

    await expect(
      withCaller(client, config, 'mallory', (tx) =>
        enqueueOutcome(client, config, tx, message),
      ),
    ).rejects.toThrow(/not uploaded by the caller/);
  });

  it('refuses an unrecorded outcome, which has no file to hang a row on', async () => {
    await expect(
      withCaller(client, config, 'alice', (tx) =>
        enqueueOutcome(client, config, tx, {
          ...({} as StatementOutcomeMessage),
          fileId: null,
        }),
      ),
    ).rejects.toThrow(/no outbox row/);
  });
});

describe('publishCommittedOutcome', () => {
  it('publishes the message and marks the row published', async () => {
    const message = await newFile();
    await withCaller(client, config, 'alice', (tx) =>
      enqueueOutcome(client, config, tx, message),
    );
    const { sent, sqs } = sqsThatWorks();

    expect(
      await publishCommittedOutcome(client, config, sqs, QUEUE, message),
    ).toBe(true);

    expect(sent).toEqual([message]);
    expect(
      (await outboxRow(message.fileId as string))?.published_at,
    ).not.toBeNull();
  });

  it('leaves the row unpublished when the publish fails (no throw)', async () => {
    const message = await newFile();
    await withCaller(client, config, 'alice', (tx) =>
      enqueueOutcome(client, config, tx, message),
    );
    const sqs = {
      send: vi.fn().mockRejectedValue(new Error('sqs down')),
    } as never;

    expect(
      await publishCommittedOutcome(client, config, sqs, QUEUE, message),
    ).toBe(false);

    expect(
      (await outboxRow(message.fileId as string))?.published_at,
    ).toBeNull();
  });
});

describe('publishDueOutcomes (the sweeper)', () => {
  it('recovers an outcome whose publish failed, without reprocessing the file', async () => {
    const message = await newFile();
    await withCaller(client, config, 'alice', (tx) =>
      enqueueOutcome(client, config, tx, message),
    );
    await publishCommittedOutcome(
      client,
      config,
      { send: vi.fn().mockRejectedValue(new Error('down')) } as never,
      QUEUE,
      message,
    );
    const { sent, sqs } = sqsThatWorks();

    // too fresh: not due yet
    expect(await publishDueOutcomes(client, config, sqs, QUEUE)).toBe(0);
    await ageOutbox(message.fileId as string);

    expect(await publishDueOutcomes(client, config, sqs, QUEUE)).toBe(1);

    expect(sent).toEqual([message]); // the same outcome, as committed
    expect(
      (await outboxRow(message.fileId as string))?.published_at,
    ).not.toBeNull();
    // and it is not published a second time
    expect(await publishDueOutcomes(client, config, sqs, QUEUE)).toBe(0);
  });

  it('keeps going when one row fails to publish', async () => {
    const a = await newFile();
    const b = await newFile();
    for (const m of [a, b]) {
      await withCaller(client, config, 'alice', (tx) =>
        enqueueOutcome(client, config, tx, m),
      );
      await ageOutbox(m.fileId as string);
    }
    const sent: string[] = [];
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockImplementation(async (command: unknown) => {
        sent.push(
          (
            JSON.parse(
              (command as { input: { MessageBody: string } }).input.MessageBody,
            ) as StatementOutcomeMessage
          ).s3Key,
        );
        return {};
      });

    const published = await publishDueOutcomes(
      client,
      config,
      { send } as never,
      QUEUE,
    );

    expect(published).toBe(1);
    expect(sent).toHaveLength(1);
    // the failed one is still pending and is picked up next time
    expect(
      await publishDueOutcomes(client, config, sqsThatWorks().sqs, QUEUE),
    ).toBe(1);
  });

  it('skips a payload that is not an outcome message', async () => {
    await executeStatement(client, config, `SELECT 1`);
    await db.exec(`
      INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status)
        VALUES ('bad', 'acc', 'alice', 'seb', 'hbad', 'kbad', 'approved');
      INSERT INTO statement_outcome_outbox (file_id, s3_key, uploaded_by, payload, created_at)
        VALUES ('bad', 'kbad', 'alice', '{"nope":true}', now() - interval '5 minutes');
    `);
    const { sent, sqs } = sqsThatWorks();

    expect(await publishDueOutcomes(client, config, sqs, QUEUE)).toBe(0);
    expect(sent).toEqual([]);
    await db.exec(`DELETE FROM statement_outcome_outbox WHERE file_id = 'bad'`);
  });
});

describe('outcome message helpers', () => {
  it('coveredPeriod takes the earliest start and latest end', () => {
    expect(
      coveredPeriod([
        { from: '2026-02-01', to: '2026-02-28' },
        { from: '2026-01-15', to: '2026-01-31' },
        { from: null, to: null },
      ]),
    ).toEqual({ from: '2026-01-15', to: '2026-02-28' });
    expect(coveredPeriod([])).toEqual({ from: null, to: null });
  });

  const valid: StatementOutcomeMessage = {
    fileId: 'f',
    s3Key: 'k',
    sub: 's',
    status: 'approved',
    reasons: [{ code: 'c', message: 'm', row: 3 }],
    warningsByAccount: { acc: [{ code: 'w', message: 'm' }] },
    newTransactionCount: 2,
    period: { from: '2026-01-01', to: null },
  };

  it('isOutcomeMessage accepts a complete message, with or without omitted counts', () => {
    expect(isOutcomeMessage(valid)).toBe(true);
    expect(isOutcomeMessage({ ...valid, fileId: null, period: null })).toBe(
      true,
    );
    expect(
      isOutcomeMessage({
        ...valid,
        omittedReasonCount: 4,
        omittedWarningCount: 0,
      }),
    ).toBe(true);
  });

  it('isOutcomeMessage rejects a half-formed message instead of letting it reach the formatter', () => {
    const without = (key: keyof StatementOutcomeMessage) => {
      const copy: Partial<StatementOutcomeMessage> = { ...valid };
      delete copy[key];
      return copy;
    };
    for (const bad of [
      { s3Key: 'k', sub: 's', status: 'rejected', reasons: [] },
      without('warningsByAccount'),
      without('newTransactionCount'),
      without('period'),
      { ...valid, reasons: [{ code: 1, message: 'm' }] },
      { ...valid, reasons: [{ code: 'c', message: 'm', row: '3' }] },
      { ...valid, warningsByAccount: { acc: 'nope' } },
      { ...valid, warningsByAccount: [] },
      { ...valid, newTransactionCount: Number.NaN },
      { ...valid, period: { from: 1, to: null } },
      { ...valid, status: 'maybe' },
      { ...valid, fileId: 7 },
      { update_id: 1 },
      null,
      'text',
    ]) {
      expect(isOutcomeMessage(bad)).toBe(false);
    }
  });
});

describe('boundOutcomeMessage', () => {
  const many = (
    n: number,
    text = 'bad row',
  ): StatementOutcomeMessage['reasons'] =>
    Array.from({ length: n }, (_, i) => ({
      code: 'bad',
      row: i + 1,
      message: text,
    }));

  it('leaves a small message as it is, with nothing omitted', () => {
    const small: StatementOutcomeMessage = {
      fileId: 'f',
      s3Key: 'k',
      sub: 's',
      status: 'rejected',
      reasons: many(3),
      warningsByAccount: {},
      newTransactionCount: 0,
      period: null,
    };
    expect(boundOutcomeMessage(small)).toEqual({
      ...small,
      omittedReasonCount: 0,
      omittedWarningCount: 0,
    });
  });

  it('keeps the first reasons and counts the rest', () => {
    const bounded = boundOutcomeMessage({
      fileId: 'f',
      s3Key: 'k',
      sub: 's',
      status: 'rejected',
      reasons: many(500),
      warningsByAccount: {},
      newTransactionCount: 0,
      period: null,
    });
    expect(bounded.reasons).toHaveLength(MAX_MESSAGE_REASONS);
    expect(bounded.reasons[0]?.row).toBe(1);
    expect(bounded.omittedReasonCount).toBe(500 - MAX_MESSAGE_REASONS);
  });

  it('shares the same cap across accounts’ warnings and counts what was dropped', () => {
    const bounded = boundOutcomeMessage({
      fileId: 'f',
      s3Key: 'k',
      sub: 's',
      status: 'approved',
      reasons: [],
      warningsByAccount: { a: many(25), b: many(25), c: many(5) },
      newTransactionCount: 1,
      period: null,
    });
    const kept = Object.values(bounded.warningsByAccount).flat().length;
    expect(kept).toBe(MAX_MESSAGE_REASONS);
    expect(bounded.omittedWarningCount).toBe(55 - MAX_MESSAGE_REASONS);
    expect(bounded.warningsByAccount['c']).toBeUndefined();
  });

  it('clips a very long reason text', () => {
    const bounded = boundOutcomeMessage({
      fileId: 'f',
      s3Key: 'k',
      sub: 's',
      status: 'rejected',
      reasons: many(1, 'x'.repeat(5000)),
      warningsByAccount: {},
      newTransactionCount: 0,
      period: null,
    });
    expect(bounded.reasons[0]?.message.length ?? 0).toBeLessThan(600);
    expect(bounded.reasons[0]?.message.endsWith('…')).toBe(true);
  });

  it('keeps even a worst-case file far under SQS’s 256 KiB body limit', () => {
    const bounded = boundOutcomeMessage({
      fileId: 'f',
      s3Key: 'k',
      sub: 's',
      status: 'rejected',
      reasons: many(200_000, 'x'.repeat(2000)),
      warningsByAccount: { a: many(200_000, 'y'.repeat(2000)) },
      newTransactionCount: 0,
      period: null,
    });
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(100 * 1024);
    expect(isOutcomeMessage(bounded)).toBe(true);
  });
});

describe('recorded_outcome lookup', () => {
  it('returns the committed payload to the uploader, whatever their membership now', async () => {
    const message = await newFile();
    await withCaller(client, config, 'alice', (tx) =>
      enqueueOutcome(client, config, tx, message),
    );
    // alice has since left the account (another owner remains)
    await db.exec(`
      INSERT INTO account_members (account_id, user_id, role) VALUES ('acc', 'other-owner', 'owner');
      DELETE FROM account_members WHERE account_id = 'acc' AND user_id = 'alice'
    `);
    try {
      const rows = await withCaller(
        client,
        config,
        'alice',
        async (tx) =>
          (
            await executeStatement(
              client,
              config,
              `SELECT CAST(draupnir.recorded_outcome(:key) AS text) AS payload`,
              { key: message.s3Key },
              tx,
            )
          ).rows,
      );
      expect(JSON.parse((rows[0] as { payload: string }).payload)).toEqual(
        message,
      );
    } finally {
      await db.exec(`
        INSERT INTO account_members (account_id, user_id, role) VALUES ('acc', 'alice', 'owner');
        ALTER TABLE account_members DISABLE TRIGGER account_members_keep_last_owner;
        DELETE FROM account_members WHERE account_id = 'acc' AND user_id = 'other-owner';
        ALTER TABLE account_members ENABLE TRIGGER account_members_keep_last_owner;
      `);
    }
  });

  it('returns nothing to anyone but the uploader', async () => {
    const message = await newFile();
    await withCaller(client, config, 'alice', (tx) =>
      enqueueOutcome(client, config, tx, message),
    );
    const rows = await withCaller(
      client,
      config,
      'mallory',
      async (tx) =>
        (
          await executeStatement(
            client,
            config,
            `SELECT CAST(draupnir.recorded_outcome(:key) AS text) AS payload`,
            { key: message.s3Key },
            tx,
          )
        ).rows,
    );
    expect((rows[0] as { payload: string | null }).payload).toBeNull();
  });
});
