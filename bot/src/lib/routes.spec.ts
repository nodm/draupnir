import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { createSubResolver } from './routes';

const config = { resourceArn: 'a', secretArn: 'b', database: 'c' };

function clientReturning(sub: string | null) {
  const send = vi.fn().mockResolvedValue({
    formattedRecords: JSON.stringify([{ sub }]),
  });
  return { send, client: { send } as unknown as RDSDataClient };
}

describe('createSubResolver', () => {
  it('returns the linked sub', async () => {
    const { client } = clientReturning('sub-9');
    expect(await createSubResolver(client, config)(123)).toBe('sub-9');
  });

  it('returns null when the Telegram user is not linked', async () => {
    const { client } = clientReturning(null);
    expect(await createSubResolver(client, config)(123)).toBeNull();
  });

  it('looks the user up through the definer function, outside any transaction', async () => {
    const { send, client } = clientReturning(null);
    await createSubResolver(client, config)(123);
    const input = send.mock.calls[0]?.[0].input;
    expect(input.sql).toContain('draupnir.sub_for_telegram_user');
    expect(input.transactionId).toBeUndefined();
  });
});
