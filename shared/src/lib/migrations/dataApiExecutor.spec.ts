import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { withResumeRetry } from '../dataApi';
import { createDataApiExecutor } from './dataApiExecutor';

const config = {
  resourceArn: 'arn:aws:rds:eu-north-1:123:cluster:test',
  secretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:test',
  database: 'draupnir',
};

function resumingError(): Error {
  const error = new Error('Aurora is resuming');
  error.name = 'DatabaseResumingException';
  return error;
}

describe('createDataApiExecutor resume retry', () => {
  it('retries the resume-in-progress error and then succeeds', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(resumingError())
      .mockRejectedValueOnce(resumingError())
      .mockResolvedValueOnce({ transactionId: 'tx-1' });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const executor = createDataApiExecutor(
      { send } as unknown as RDSDataClient,
      config,
      { sleep },
    );

    await expect(executor.begin()).resolves.toBe('tx-1');

    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it('waits for the cluster once, not once per layer', async () => {
    const send = vi.fn().mockRejectedValue(resumingError());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const executor = createDataApiExecutor(
      { send } as unknown as RDSDataClient,
      config,
      { sleep, maxTotalWaitMs: 5000 },
    );

    await expect(executor.begin()).rejects.toMatchObject({
      name: 'DatabaseResumingException',
    });

    // 1 + 2 + 2 s of waiting (capped at the 5 s budget), then it gives up: no
    // second cycle inside another retry.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 2000]);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('gives the migration runner a longer budget than the default', async () => {
    const send = vi.fn().mockRejectedValue(resumingError());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const executor = createDataApiExecutor(
      { send } as unknown as RDSDataClient,
      config,
      { sleep },
    );

    await expect(executor.begin()).rejects.toThrow();

    const total = sleep.mock.calls.reduce((n, [ms]) => n + (ms as number), 0);
    expect(total).toBe(120_000);
  });

  it('does not retry other errors', async () => {
    const send = vi.fn().mockRejectedValue(new Error('syntax error'));
    const sleep = vi.fn();
    const executor = createDataApiExecutor(
      { send } as unknown as RDSDataClient,
      config,
      { sleep },
    );

    await expect(executor.execute('SELECT 1')).rejects.toThrow('syntax error');

    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('createDataApiExecutor receiver', () => {
  it('calls send with the client as its receiver, like the real SDK client', async () => {
    // The real RDSDataClient.send reads this.config / this.middlewareStack.
    class ReceiverSensitiveClient {
      readonly config = { ok: true };
      async send(): Promise<{ transactionId: string }> {
        if (!this?.config?.ok) {
          throw new TypeError('send called without its receiver');
        }
        return { transactionId: 'tx-1' };
      }
    }
    const executor = createDataApiExecutor(
      new ReceiverSensitiveClient() as unknown as RDSDataClient,
      config,
    );

    await expect(executor.begin()).resolves.toBe('tx-1');
  });
});

describe('withResumeRetry', () => {
  it('gives up once the total wait cap is spent', async () => {
    const call = vi.fn().mockRejectedValue(resumingError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withResumeRetry(call, {
        maxTotalWaitMs: 5000,
        initialDelayMs: 1000,
        sleep,
      }),
    ).rejects.toThrow('Aurora is resuming');

    const waited = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(waited).toBe(5000);
  });
});
