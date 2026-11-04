// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { applyMigrationsForTest } from './migrations/applyMigrationsForTest';

// Runs as the non-owner `draupnir_app`, one transaction per "request", like
// withCaller. Seeding and clock manipulation use the owner connection.

let db: PGlite;

async function asApp<T>(sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec('SET ROLE draupnir_app');
  await db.exec('BEGIN');
  try {
    if (sub !== null) {
      await db.query(`SELECT set_config('app.sub', $1, true)`, [sub]);
    }
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  } finally {
    await db.exec('RESET ROLE');
  }
}

const rows = async <T>(sub: string | null, sql: string, params?: unknown[]) =>
  asApp(sub, async () => (await db.query<T>(sql, params)).rows);

const FAR = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

async function createRequest(
  state: string,
  telegramUserId: number,
  expiresAt = FAR,
) {
  await rows(
    null,
    `SELECT draupnir.create_link_request($1, $2, $3, 'Ann', 'ann', 'verifier', $4)`,
    [state, telegramUserId, telegramUserId, expiresAt],
  );
}

// Walks a request to the pending-link stage (sign-in done, code issued).
async function pendingLink(
  state: string,
  telegramUserId: number,
  sub: string,
  codeHash = 'code-hash',
) {
  await createRequest(state, telegramUserId);
  await rows(null, `SELECT * FROM draupnir.consume_link_state($1)`, [state]);
  const r = await rows<{ set_pending_link: string }>(
    null,
    `SELECT draupnir.set_pending_link($1, $2, $3, $4)`,
    [state, sub, `${sub}@example.com`, codeHash],
  );
  return r[0]?.set_pending_link;
}

const redeem = async (telegramUserId: number, codeHash: string) =>
  (
    await rows<{ status: string; linked_email: string | null }>(
      null,
      `SELECT * FROM draupnir.redeem_link_code($1, $2)`,
      [telegramUserId, codeHash],
    )
  )[0];

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('row visibility', () => {
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES
        (1, 'alice', 'a@example.com'), (2, 'bob', 'b@example.com');
      INSERT INTO bot_conversations (user_id, kind, state, expires_at) VALUES
        ('alice', 'newaccount', '{}', '2999-01-01'), ('bob', 'share', '{}', '2999-01-01');
    `);
  });

  it('a user reads only their own messenger_links and bot_conversations', async () => {
    expect(
      await rows<{ user_id: string }>(
        'alice',
        'SELECT user_id FROM messenger_links',
      ),
    ).toEqual([{ user_id: 'alice' }]);
    expect(
      await rows<{ user_id: string }>(
        'bob',
        'SELECT user_id FROM bot_conversations',
      ),
    ).toEqual([{ user_id: 'bob' }]);
    expect(await rows('carol', 'SELECT * FROM messenger_links')).toEqual([]);
    expect(await rows(null, 'SELECT * FROM bot_conversations')).toEqual([]);
  });

  it('a user cannot write a row for someone else', async () => {
    await expect(
      rows(
        'alice',
        `INSERT INTO bot_conversations (user_id, kind, state, expires_at) VALUES ('bob2', 'x', '{}', '2999-01-01')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a user cannot create a link directly', async () => {
    await expect(
      rows(
        'carol',
        `INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (9, 'carol', 'c@example.com')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('resolves a Telegram user to a sub only through the definer function', async () => {
    expect(
      await rows<{ s: string | null }>(
        null,
        `SELECT draupnir.sub_for_telegram_user(2) AS s`,
      ),
    ).toEqual([{ s: 'bob' }]);
    expect(
      await rows<{ s: string | null }>(
        null,
        `SELECT draupnir.sub_for_telegram_user(99) AS s`,
      ),
    ).toEqual([{ s: null }]);
  });

  it('unlinking removes only the caller’s link', async () => {
    await db.exec(
      `INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (3, 'dave', 'd@example.com')`,
    );
    const res = await asApp(
      'dave',
      async () => (await db.query(`DELETE FROM messenger_links`)).affectedRows,
    );
    expect(res).toBe(1);
    expect(await rows('alice', 'SELECT 1 FROM messenger_links')).toHaveLength(
      1,
    );
  });
});

describe('messenger_links uniqueness', () => {
  it('rejects a second link for the same Telegram user or the same sub', async () => {
    await db.exec(
      `INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (20, 'u20', 'e')`,
    );
    await expect(
      db.exec(
        `INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (20, 'other', 'e')`,
      ),
    ).rejects.toThrow(/unique/);
    await expect(
      db.exec(
        `INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES (21, 'u20', 'e')`,
      ),
    ).rejects.toThrow(/unique/);
  });
});

describe('link_requests', () => {
  it('is not directly readable or writable by the app role', async () => {
    await expect(rows('alice', 'SELECT * FROM link_requests')).rejects.toThrow(
      /permission denied/,
    );
    await expect(rows('alice', `DELETE FROM link_requests`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('consume succeeds once and fails when reused', async () => {
    await createRequest('s-once', 100);
    const first = await rows<{
      telegram_user_id: string;
      pkce_verifier: string;
    }>(null, `SELECT * FROM draupnir.consume_link_state('s-once')`);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ pkce_verifier: 'verifier' });
    expect(
      await rows(null, `SELECT * FROM draupnir.consume_link_state('s-once')`),
    ).toEqual([]);
  });

  it('consume fails for an expired or unknown state', async () => {
    await createRequest('s-old', 101, PAST);
    expect(
      await rows(null, `SELECT * FROM draupnir.consume_link_state('s-old')`),
    ).toEqual([]);
    expect(
      await rows(null, `SELECT * FROM draupnir.consume_link_state('nope')`),
    ).toEqual([]);
  });

  it('a newer request replaces the earlier one for the same Telegram user', async () => {
    await createRequest('s-a', 102);
    await createRequest('s-b', 102);
    expect(
      await rows(null, `SELECT * FROM draupnir.consume_link_state('s-a')`),
    ).toEqual([]);
    expect(
      await rows(null, `SELECT * FROM draupnir.consume_link_state('s-b')`),
    ).toHaveLength(1);
  });
});

describe('linking by confirmation code', () => {
  it('links only when the requesting Telegram user sends the right code', async () => {
    expect(await pendingLink('s-ok', 200, 'u200')).toBe('ok');
    expect(await redeem(200, 'code-hash')).toEqual({
      status: 'linked',
      linked_email: 'u200@example.com',
    });
    expect(
      await rows(null, `SELECT draupnir.sub_for_telegram_user(200) AS s`),
    ).toEqual([{ s: 'u200' }]);
  });

  it('sign-in alone links nothing', async () => {
    await pendingLink('s-nolink', 201, 'u201');
    expect(
      await rows(null, `SELECT draupnir.sub_for_telegram_user(201) AS s`),
    ).toEqual([{ s: null }]);
  });

  it('a code sent from another Telegram account does not link', async () => {
    await pendingLink('s-other', 202, 'u202');
    expect((await redeem(999, 'code-hash'))?.status).toBe('none');
    expect(
      await rows(null, `SELECT draupnir.sub_for_telegram_user(202) AS s`),
    ).toEqual([{ s: null }]);
    // the real requester can still complete it
    expect((await redeem(202, 'code-hash'))?.status).toBe('linked');
  });

  it('the 5th wrong code cancels the request', async () => {
    await pendingLink('s-wrong', 203, 'u203');
    for (let i = 0; i < 4; i++) {
      expect((await redeem(203, 'bad'))?.status).toBe('wrong');
    }
    expect((await redeem(203, 'bad'))?.status).toBe('cancelled');
    // even the right code no longer works
    expect((await redeem(203, 'code-hash'))?.status).toBe('none');
  });

  it('an expired code is refused', async () => {
    await pendingLink('s-exp', 204, 'u204');
    await db.exec(
      `UPDATE link_requests SET code_expires_at = now() - interval '1 second' WHERE telegram_user_id = 204`,
    );
    expect((await redeem(204, 'code-hash'))?.status).toBe('expired');
    expect(
      await rows(null, `SELECT draupnir.sub_for_telegram_user(204) AS s`),
    ).toEqual([{ s: null }]);
  });

  it('refuses a sub that is already linked to another Telegram user', async () => {
    await pendingLink('s-first', 205, 'u205');
    await redeem(205, 'code-hash');
    expect(await pendingLink('s-second', 206, 'u205')).toBe(
      'sub_already_linked',
    );
  });

  it('set_pending_link rejects a state that was never consumed', async () => {
    await createRequest('s-unconsumed', 207);
    expect(
      (
        await rows<{ r: string }>(
          null,
          `SELECT draupnir.set_pending_link('s-unconsumed', 'u', 'e', 'h') AS r`,
        )
      )[0]?.r,
    ).toBe('invalid');
  });
});

describe('statement_outcome_outbox', () => {
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units)
        VALUES ('ob-acc', 'seb', 'OBIBAN', 'EUR', 'x', '2024-01-01', 0);
      INSERT INTO account_members (account_id, user_id, role) VALUES ('ob-acc', 'alice', 'owner');
      INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, sha256, s3_key, status) VALUES
        ('of1', 'ob-acc', 'alice', 'seb', 'oh1', 'ok1', 'approved'),
        ('of2', 'ob-acc', 'alice', 'seb', 'oh2', 'ok2', 'rejected');
    `);
  });

  it('has RLS with a deny-all policy and no direct grants', async () => {
    const t = await db.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'statement_outcome_outbox'`,
    );
    expect(t.rows[0]?.relrowsecurity).toBe(true);
    const p = await db.query<{ polqual: string }>(
      `SELECT pg_get_expr(polqual, polrelid) AS polqual FROM pg_policy
        WHERE polrelid = 'statement_outcome_outbox'::regclass`,
    );
    expect(p.rows).toEqual([{ polqual: 'false' }]);
    await expect(
      rows('alice', 'SELECT * FROM statement_outcome_outbox'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      rows(
        'alice',
        `INSERT INTO statement_outcome_outbox (file_id, s3_key, uploaded_by, payload) VALUES ('of1', 'ok1', 'alice', '{}')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('enqueue_outcome records the outcome for the uploader’s own file', async () => {
    await asApp('alice', () =>
      db.query(
        `SELECT draupnir.enqueue_outcome('of1', '{"status":"approved"}')`,
      ),
    );
    const r = await db.query<{ s3_key: string; uploaded_by: string }>(
      `SELECT s3_key, uploaded_by FROM statement_outcome_outbox WHERE file_id = 'of1'`,
    );
    expect(r.rows).toEqual([{ s3_key: 'ok1', uploaded_by: 'alice' }]);
  });

  it('enqueue_outcome is idempotent per file', async () => {
    await asApp('alice', () =>
      db.query(
        `SELECT draupnir.enqueue_outcome('of1', '{"status":"approved"}')`,
      ),
    );
    const r = await db.query(
      `SELECT 1 FROM statement_outcome_outbox WHERE file_id = 'of1'`,
    );
    expect(r.rows).toHaveLength(1);
  });

  it('enqueue_outcome refuses a file the caller did not upload', async () => {
    await expect(
      asApp('mallory', () =>
        db.query(`SELECT draupnir.enqueue_outcome('of2', '{}')`),
      ),
    ).rejects.toThrow(/not uploaded by the caller/);
    await expect(
      rows(null, `SELECT draupnir.enqueue_outcome('of2', '{}')`),
    ).rejects.toThrow(/not uploaded by the caller/);
  });

  it('due_outcomes returns unpublished rows older than a minute until marked published', async () => {
    const due = () =>
      rows<{ file_id: string }>(
        null,
        `SELECT * FROM draupnir.due_outcomes(10)`,
      );
    expect(await due()).toEqual([]); // too fresh
    await db.exec(
      `UPDATE statement_outcome_outbox SET created_at = now() - interval '2 minutes'`,
    );
    expect(await due()).toMatchObject([{ file_id: 'of1', s3_key: 'ok1' }]);
    await rows(null, `SELECT draupnir.mark_outcome_published('of1')`);
    expect(await due()).toEqual([]);
  });

  it('rolls back with the import transaction: nothing is enqueued if it fails', async () => {
    await expect(
      asApp('alice', async () => {
        await db.query(`SELECT draupnir.enqueue_outcome('of2', '{}')`);
        throw new Error('import failed');
      }),
    ).rejects.toThrow('import failed');
    const r = await db.query(
      `SELECT 1 FROM statement_outcome_outbox WHERE file_id = 'of2'`,
    );
    expect(r.rows).toEqual([]);
  });
});

describe('claim_outcome_report', () => {
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO bot_pending_uploads (id, user_id, chat_id, message_id, telegram_file_id, s3_key, expires_at)
        VALUES ('p1', 'alice', 50, 7, 'tg-file', 'claim-key', '2999-01-01');
    `);
  });

  const claim = () =>
    rows<{ chat_id: number; message_id: number }>(
      null,
      `SELECT * FROM draupnir.claim_outcome_report('claim-key')`,
    );

  it('returns a row to exactly one of two callers', async () => {
    const [a, b] = [await claim(), await claim()];
    expect([a.length, b.length].sort()).toEqual([0, 1]);
    expect(a[0] ?? b[0]).toMatchObject({ message_id: 7 });
  });

  it('does not re-grant before the lease expires, and does after', async () => {
    expect(await claim()).toEqual([]);
    await db.exec(
      `UPDATE bot_pending_uploads SET report_claimed_at = now() - interval '3 minutes' WHERE id = 'p1'`,
    );
    expect(await claim()).toHaveLength(1);
  });

  it('never re-grants once reported', async () => {
    await rows(null, `SELECT draupnir.mark_outcome_reported('claim-key')`);
    await db.exec(
      `UPDATE bot_pending_uploads SET report_claimed_at = now() - interval '1 hour' WHERE id = 'p1'`,
    );
    expect(await claim()).toEqual([]);
  });
});

describe('retention functions', () => {
  it('lists only undeleted, unfailed messages older than 24 hours', async () => {
    await db.exec(`
      INSERT INTO bot_messages (chat_id, message_id, user_id, sent_at) VALUES
        (1, 1, 'alice', now() - interval '25 hours'),
        (1, 2, 'alice', now() - interval '1 hour'),
        (1, 3, 'alice', now() - interval '30 hours'),
        (1, 4, 'alice', now() - interval '26 hours');
    `);
    await rows(null, `SELECT draupnir.mark_bot_message_deleted(1, 3)`);
    await rows(null, `SELECT draupnir.mark_bot_message_failed(1, 4)`);
    expect(
      await rows<{ message_id: number }>(
        null,
        `SELECT message_id FROM draupnir.due_bot_messages(10)`,
      ),
    ).toEqual([{ message_id: 1 }]);
  });
});
