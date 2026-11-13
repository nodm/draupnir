// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationsForTest, createPgliteDataApiClient } from 'shared';
import { TelegramApiError, type TelegramClient } from '../telegram';
import { createRetention, sweepRetention, withRetention } from './retention';

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

// Chat id = Telegram user id in a private chat. 11 is linked to alice, 12 to
// bob; 99 is linked to nobody.
beforeEach(async () => {
  await db.exec(`
    TRUNCATE messenger_links, bot_messages;
    INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES
      (11, 'alice', 'a@example.com'), (12, 'bob', 'b@example.com');
  `);
});

interface Row {
  chat_id: number;
  message_id: number;
  user_id: string;
  deleted_at: string | null;
  failed_at: string | null;
  claimed_at: string | null;
}
const rows = async () =>
  (
    await db.query<Row>(
      `SELECT chat_id, message_id, user_id, deleted_at, failed_at, claimed_at FROM bot_messages ORDER BY chat_id, message_id`,
    )
  ).rows;

// A recorded message that was sent `hoursAgo` hours ago.
const sentAgo = (chatId: number, messageId: number, hoursAgo: number) =>
  db.exec(
    `INSERT INTO bot_messages (chat_id, message_id, user_id, sent_at)
     VALUES (${chatId}, ${messageId}, 'alice', now() - interval '${hoursAgo} hours')`,
  );

function fakeTelegram(
  deleteMessage: (chat: number, message: number) => Promise<void> = async () =>
    undefined,
) {
  const sendMessage = vi.fn(async (chatId: number) => ({
    message_id: chatId * 1000 + 1,
  }));
  const del = vi.fn(deleteMessage);
  return {
    sendMessage,
    deleteMessage: del,
    telegram: { sendMessage, deleteMessage: del } as unknown as TelegramClient,
  };
}

const notFound = () =>
  new TelegramApiError(
    'deleteMessage',
    400,
    'Bad Request: message to delete not found',
  );
const tooOld = () =>
  new TelegramApiError(
    'deleteMessage',
    400,
    "Bad Request: message can't be deleted for everyone",
  );

const quiet = () =>
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

describe('recording', () => {
  it('records a message in a linked chat under that chat’s user', async () => {
    await createRetention(client, config).record(11, 5);
    expect(await rows()).toEqual([
      expect.objectContaining({
        chat_id: 11,
        message_id: 5,
        user_id: 'alice',
        deleted_at: null,
      }),
    ]);
  });

  it('records a message sent to someone else’s chat under that person, not the sender', async () => {
    await createRetention(client, config).record(12, 6);
    expect((await rows())[0]?.user_id).toBe('bob');
  });

  it('records nothing for a chat nobody is linked to', async () => {
    await createRetention(client, config).record(99, 1);
    expect(await rows()).toEqual([]);
  });

  it('recording the same message twice leaves one record', async () => {
    const retention = createRetention(client, config);
    await retention.record(11, 5);
    await retention.record(11, 5);
    expect(await rows()).toHaveLength(1);
  });

  it('does not fail the caller when recording fails, and says so in the log', async () => {
    const error = quiet();
    const broken = createRetention(
      { send: async () => Promise.reject(new Error('db down')) } as never,
      config,
    );

    await expect(broken.record(11, 5)).resolves.toBeUndefined();
    expect(error.mock.calls[0]?.[0]).toContain('retention-record-failed');
    error.mockRestore();
  });

  it('every message the bot sends through the wrapped client is recorded', async () => {
    const t = fakeTelegram();
    const wrapped = withRetention(t.telegram, createRetention(client, config));

    await wrapped.sendMessage(11, 'Your accounts: …');
    await wrapped.sendMessage(12, 'Alice shared an account with you');

    expect((await rows()).map((r) => [r.chat_id, r.user_id])).toEqual([
      [11, 'alice'],
      [12, 'bob'],
    ]);
    expect(t.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not record a message that failed to send', async () => {
    const t = fakeTelegram();
    t.sendMessage.mockRejectedValueOnce(new Error('blocked'));
    const wrapped = withRetention(t.telegram, createRetention(client, config));

    await expect(wrapped.sendMessage(11, 'x')).rejects.toThrow('blocked');
    expect(await rows()).toEqual([]);
  });
});

describe('discarding a message now', () => {
  it('deletes it and marks the record', async () => {
    await sentAgo(11, 5, 1);
    const t = fakeTelegram();
    await createRetention(client, config).discard(t.telegram, 11, 5);

    expect(t.deleteMessage).toHaveBeenCalledWith(11, 5);
    expect((await rows())[0]?.deleted_at).not.toBeNull();
  });

  it('treats a message that is already gone as deleted', async () => {
    await sentAgo(11, 5, 1);
    const t = fakeTelegram(async () => Promise.reject(notFound()));
    await createRetention(client, config).discard(t.telegram, 11, 5);
    expect((await rows())[0]?.deleted_at).not.toBeNull();
  });

  it('leaves the record for the scheduled run when deletion fails, and does not throw', async () => {
    const error = quiet();
    await sentAgo(11, 5, 1);
    const t = fakeTelegram(async () => Promise.reject(new Error('network')));

    await expect(
      createRetention(client, config).discard(t.telegram, 11, 5),
    ).resolves.toBeUndefined();

    const [row] = await rows();
    expect(row?.deleted_at).toBeNull();
    expect(row?.failed_at).toBeNull();
    expect(error.mock.calls[0]?.[0]).toContain('retention-discard-failed');
    error.mockRestore();
  });
});

describe('the scheduled run', () => {
  it('deletes a message sent more than 20 hours ago', async () => {
    await sentAgo(11, 1, 21);
    const t = fakeTelegram();

    expect(await sweepRetention(t.telegram, client, config)).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(t.deleteMessage).toHaveBeenCalledWith(11, 1);
    expect((await rows())[0]?.deleted_at).not.toBeNull();
  });

  it('leaves a message younger than 20 hours alone', async () => {
    await sentAgo(11, 1, 19);
    const t = fakeTelegram();

    expect(await sweepRetention(t.telegram, client, config)).toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(t.deleteMessage).not.toHaveBeenCalled();
    expect((await rows())[0]?.deleted_at).toBeNull();
  });

  it('still deletes a message the previous 12-hourly run missed (44 hours old)', async () => {
    await sentAgo(11, 1, 44);
    const t = fakeTelegram();

    expect(await sweepRetention(t.telegram, client, config)).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(t.deleteMessage).toHaveBeenCalledWith(11, 1);
    expect((await rows())[0]?.deleted_at).not.toBeNull();
  });

  it('does not delete a message twice across runs', async () => {
    await sentAgo(11, 1, 30);
    const t = fakeTelegram();
    await sweepRetention(t.telegram, client, config);
    await sweepRetention(t.telegram, client, config);
    expect(t.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('reports a failed deletion with the chat and message id, marks it, and never retries it', async () => {
    const error = quiet();
    await sentAgo(11, 1, 60); // past Telegram's 48-hour limit
    const t = fakeTelegram(async () => Promise.reject(tooOld()));

    expect(await sweepRetention(t.telegram, client, config)).toEqual({
      deleted: 0,
      failed: 1,
    });
    const logged = JSON.parse(error.mock.calls[0]?.[0] as string);
    expect(logged).toMatchObject({
      event: 'retention-delete-failed',
      chatId: 11,
      messageId: 1,
    });
    expect((await rows())[0]?.failed_at).not.toBeNull();

    await sweepRetention(t.telegram, client, config);
    expect(t.deleteMessage).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('one failure does not stop the rest', async () => {
    const error = quiet();
    await sentAgo(11, 1, 30);
    await sentAgo(11, 2, 29);
    await sentAgo(11, 3, 28);
    const t = fakeTelegram(async (_c, m) =>
      m === 2 ? Promise.reject(tooOld()) : undefined,
    );

    expect(await sweepRetention(t.telegram, client, config)).toEqual({
      deleted: 2,
      failed: 1,
    });
    expect(
      (await rows()).map((r) => [r.message_id, !!r.deleted_at, !!r.failed_at]),
    ).toEqual([
      [1, true, false],
      [2, false, true],
      [3, true, false],
    ]);
    error.mockRestore();
  });

  it('counts a message the user already deleted as done, not failed', async () => {
    await sentAgo(11, 1, 30);
    const t = fakeTelegram(async () => Promise.reject(notFound()));

    expect(await sweepRetention(t.telegram, client, config)).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect((await rows())[0]?.failed_at).toBeNull();
  });

  it('works through more messages than fit in one batch', async () => {
    await db.exec(
      `INSERT INTO bot_messages (chat_id, message_id, user_id, sent_at)
       SELECT 11, g, 'alice', now() - interval '30 hours' FROM generate_series(1, 230) g`,
    );
    const t = fakeTelegram();

    expect((await sweepRetention(t.telegram, client, config)).deleted).toBe(
      230,
    );
  });

  it('stops after 2000 messages per run and leaves the rest for the next one', async () => {
    await db.exec(
      `INSERT INTO bot_messages (chat_id, message_id, user_id, sent_at)
       SELECT 11, g, 'alice', now() - interval '30 hours' FROM generate_series(1, 2050) g`,
    );
    const t = fakeTelegram();

    expect((await sweepRetention(t.telegram, client, config)).deleted).toBe(
      2000,
    );
    expect((await sweepRetention(t.telegram, client, config)).deleted).toBe(50);
  }, 60_000);
});

describe('overlapping runs', () => {
  const claimed = async () =>
    (
      await db.query<{ message_id: number }>(
        `SELECT message_id FROM draupnir.claim_due_bot_messages(100) ORDER BY message_id`,
      )
    ).rows.map((r) => Number(r.message_id));

  it('a second run does not get messages a first run has claimed', async () => {
    await sentAgo(11, 1, 30);
    await sentAgo(11, 2, 30);

    expect(await claimed()).toEqual([1, 2]);
    expect(await claimed()).toEqual([]);
  });

  it('a sweep skips messages another run holds, so none is tried twice', async () => {
    await sentAgo(11, 1, 30);
    await sentAgo(11, 2, 30);
    await claimed(); // the other run holds both
    const t = fakeTelegram();

    expect(await sweepRetention(t.telegram, client, config)).toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(t.deleteMessage).not.toHaveBeenCalled();
  });

  it('takes over messages from a run that died, once its lease has lapsed', async () => {
    await sentAgo(11, 1, 30);
    await claimed();
    await db.exec(
      `UPDATE bot_messages SET claimed_at = now() - interval '16 minutes'`,
    );
    const t = fakeTelegram();

    expect(await sweepRetention(t.telegram, client, config)).toEqual({
      deleted: 1,
      failed: 0,
    });
  });

  it('claiming never touches messages that are too young or already handled', async () => {
    await sentAgo(11, 1, 5);
    await sentAgo(11, 2, 30);
    await db.exec(
      `UPDATE bot_messages SET deleted_at = now() WHERE message_id = 2`,
    );
    await sentAgo(11, 3, 30);
    await db.exec(
      `UPDATE bot_messages SET failed_at = now() WHERE message_id = 3`,
    );

    expect(await claimed()).toEqual([]);
  });
});
