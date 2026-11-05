// @vitest-environment node
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  batchExecuteStatement,
  beginTransaction,
  executeStatement,
  withCaller,
  type DataApiConfig,
} from './dataApi';

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

describe('waking from an Aurora pause', () => {
  const resuming = () =>
    Object.assign(new Error('The Aurora DB instance is resuming'), {
      name: 'DatabaseResumingException',
    });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // A client that refuses `times` calls while resuming, then answers.
  function sleepyClient(times: number, error: () => Error = resuming) {
    let left = times;
    const send = vi.fn(async () => {
      if (left-- > 0) throw error();
      return { formattedRecords: '[{"n":1}]', transactionId: 'tx-1' };
    });
    return { client: { send } as unknown as RDSDataClient, send };
  }

  it('waits and asks again, so the caller never sees the pause', async () => {
    const { client, send } = sleepyClient(3);

    const promise = executeStatement(client, config, 'SELECT 1');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await promise).toMatchObject({ rows: [{ n: 1 }] });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('backs off between attempts instead of hammering the cluster', async () => {
    const { client, send } = sleepyClient(3);

    const promise = executeStatement(client, config, 'SELECT 1');
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1); // still waiting for the first delay
    await vi.advanceTimersByTimeAsync(600); // 1s: second attempt
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); // third waits 2s
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;
  });

  it('gives up with the original error when the cluster does not wake in time', async () => {
    const { client, send } = sleepyClient(Number.POSITIVE_INFINITY);

    const promise = executeStatement(client, config, 'SELECT 1');
    const settled = expect(promise).rejects.toMatchObject({
      name: 'DatabaseResumingException',
    });
    await vi.advanceTimersByTimeAsync(120_000);

    await settled;
    expect(send.mock.calls.length).toBeGreaterThan(3);
    expect(send.mock.calls.length).toBeLessThan(15);
  });

  it('waits at most the budget its config gives it', async () => {
    const { client, send } = sleepyClient(Number.POSITIVE_INFINITY);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      executeStatement(
        client,
        { ...config, resumeRetry: { maxTotalWaitMs: 3000, sleep } },
        'SELECT 1',
      ),
    ).rejects.toMatchObject({ name: 'DatabaseResumingException' });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other error', async () => {
    const { client, send } = sleepyClient(1, () => new Error('syntax error'));

    await expect(executeStatement(client, config, 'SELECT')).rejects.toThrow(
      'syntax error',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('covers beginning a transaction and batch writes too', async () => {
    const begin = sleepyClient(1);
    const started = beginTransaction(begin.client, config);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await started).toBe('tx-1');

    const batch = sleepyClient(1);
    const wrote = batchExecuteStatement(batch.client, config, 'INSERT', [{}]);
    await vi.advanceTimersByTimeAsync(5_000);
    await wrote;
    expect(batch.send).toHaveBeenCalledTimes(2);
  });
});
