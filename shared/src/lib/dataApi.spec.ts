// @vitest-environment node
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { withCaller, type DataApiConfig } from './dataApi';

const config: DataApiConfig = {
  resourceArn: 'arn',
  secretArn: 'secret',
  database: 'db',
};

function mockClient() {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const send = vi.fn(async (command: unknown) => {
    const c = command as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    sent.push({ name: c.constructor.name, input: c.input });
    return c.constructor.name === 'BeginTransactionCommand'
      ? { transactionId: 'tx-1' }
      : {};
  });
  return { client: { send } as unknown as RDSDataClient, sent };
}

describe('withCaller', () => {
  it('begins, sets identity transaction-locally, runs the body, then commits', async () => {
    const { client, sent } = mockClient();

    const result = await withCaller(client, config, 'user-1', async (tx) => {
      expect(tx).toBe('tx-1');
      return 'done';
    });

    expect(result).toBe('done');
    expect(sent.map((c) => c.name)).toEqual([
      'BeginTransactionCommand',
      'ExecuteStatementCommand',
      'CommitTransactionCommand',
    ]);
    const set = sent[1].input;
    expect(set['sql']).toBe(`SELECT set_config('app.sub', :sub, true)`);
    expect(set['transactionId']).toBe('tx-1');
    // Bound as a parameter, never interpolated.
    expect(set['parameters']).toEqual([
      { name: 'sub', value: { stringValue: 'user-1' } },
    ]);
  });

  it('rolls back and rethrows when the body fails', async () => {
    const { client, sent } = mockClient();

    await expect(
      withCaller(client, config, 'user-1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(sent.map((c) => c.name)).toEqual([
      'BeginTransactionCommand',
      'ExecuteStatementCommand',
      'RollbackTransactionCommand',
    ]);
  });

  it('rolls back when setting the identity fails', async () => {
    const { client, sent } = mockClient();
    const send = client.send as unknown as ReturnType<typeof vi.fn>;
    const original = send.getMockImplementation() as (
      c: unknown,
    ) => Promise<unknown>;
    send.mockImplementation(async (c: unknown) => {
      if ((c as object).constructor.name === 'ExecuteStatementCommand') {
        throw new Error('set failed');
      }
      return original(c);
    });

    await expect(
      withCaller(client, config, 'user-1', async () => 1),
    ).rejects.toThrow('set failed');
    expect(sent.at(-1)?.name).toBe('RollbackTransactionCommand');
  });

  it('refuses an empty sub without touching the database', async () => {
    const { client, sent } = mockClient();

    await expect(withCaller(client, config, '', async () => 1)).rejects.toThrow(
      /non-empty sub/,
    );
    expect(sent).toEqual([]);
  });
});
