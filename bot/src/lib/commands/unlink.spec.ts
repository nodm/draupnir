// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import type { Update } from '@grammyjs/types';
import { applyMigrationsForTest, createPgliteDataApiClient } from 'shared';
import { dispatch } from '../dispatcher';
import { createRoutes, createSubResolver } from '../routes';
import type { TelegramClient } from '../telegram';
import { createUnlinkHandler } from './unlink';

const config = { resourceArn: 'a', secretArn: 'b', database: 'c' };

let db: PGlite;
let routes: ReturnType<typeof createRoutes>;
const onUnlinked = vi.fn().mockResolvedValue(undefined);
const accounts = vi.fn().mockResolvedValue(undefined);

beforeAll(async () => {
  db = new PGlite();
  await applyMigrationsForTest(db);
  await db.exec(`
    INSERT INTO messenger_links (telegram_user_id, user_id, email) VALUES
      (1, 'alice', 'a@example.com'), (2, 'bob', 'b@example.com')
  `);
  const { client } = createPgliteDataApiClient(db, { role: 'draupnir_app' });
  routes = createRoutes({
    resolveSub: createSubResolver(client, config),
    onUnlinked,
    commands: { unlink: createUnlinkHandler(client, config), accounts },
  });
}, 60_000);

afterAll(async () => {
  await db.close();
});

const say = (userId: number, text: string): Update =>
  ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: userId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'U' },
      text,
    },
  }) as Update;

describe('/unlink', () => {
  it('removes the link at once: the next message is treated as unlinked', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const telegram = { sendMessage } as unknown as TelegramClient;

    await dispatch(say(1, '/unlink'), telegram, routes);
    expect(sendMessage).toHaveBeenCalledWith(
      1,
      expect.stringMatching(/Unlinked/),
    );

    await dispatch(say(1, '/accounts'), telegram, routes);
    expect(accounts).not.toHaveBeenCalled();
    expect(onUnlinked).toHaveBeenCalledTimes(1);
  });

  it('only removes the caller’s own link', async () => {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM messenger_links`,
    );
    expect(rows).toEqual([{ user_id: 'bob' }]);
  });
});
