import type { SQSEvent } from 'aws-lambda';

const processStatementFile = vi.fn().mockResolvedValue({
  fileId: 'file-1',
  status: 'approved',
  reasons: [],
  warningsByAccount: {},
  redelivered: false,
  report: null,
});

vi.mock('./lib/processStatementFile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/processStatementFile')>()),
  processStatementFile,
}));
const publishCommittedOutcome = vi.fn().mockResolvedValue(true);
const publishDueOutcomes = vi.fn().mockResolvedValue(0);
const sendOutcome = vi.fn().mockResolvedValue(undefined);

vi.mock('shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('shared')>()),
  publishCommittedOutcome: (...args: unknown[]) =>
    publishCommittedOutcome(...args),
  publishDueOutcomes: (...args: unknown[]) => publishDueOutcomes(...args),
  sendOutcome: (...args: unknown[]) => sendOutcome(...args),
  loadDataApiConfigFromEnv: () => ({
    resourceArn: 'arn:aws:rds:eu-north-1:123:cluster:test',
    secretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:test',
    database: 'draupnir',
  }),
}));

function sqsEvent(body: unknown): SQSEvent {
  return {
    Records: [{ body: JSON.stringify(body) } as SQSEvent['Records'][number]],
  } as SQSEvent;
}

describe('ingest handler', () => {
  beforeEach(() => {
    processStatementFile.mockClear();
  });

  it('skips an S3 test event (no Records array) instead of crashing', async () => {
    const { handler } = await import('./handler');
    const event = sqsEvent({
      Service: 'Amazon S3',
      Event: 's3:TestEvent',
      Time: '2026-08-29T00:00:00.000Z',
      Bucket: 'draupnir-uploads',
      RequestId: 'req-1',
      HostId: 'host-1',
    });

    await expect(
      handler(event, {} as never, () => undefined),
    ).resolves.not.toThrow();
    expect(processStatementFile).not.toHaveBeenCalled();
  });

  it('processes a real S3 object-created notification', async () => {
    const { handler } = await import('./handler');
    const event = sqsEvent({
      Records: [
        {
          s3: {
            bucket: { name: 'draupnir-uploads' },
            object: { key: 'uploads/user-1/acc-1/file.csv', size: 1234 },
          },
        },
      ],
    });

    await handler(event, {} as never, () => undefined);

    expect(processStatementFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'draupnir-uploads',
      'uploads/user-1/acc-1/file.csv',
      1234,
    );
  });

  describe('publishing outcomes', () => {
    const upload = {
      Records: [
        {
          s3: {
            bucket: { name: 'draupnir-uploads' },
            object: { key: 'uploads/user-1/acc-1/file.csv', size: 10 },
          },
        },
      ],
    };
    const report = {
      fileId: 'file-1',
      s3Key: 'uploads/user-1/acc-1/file.csv',
      sub: 'user-1',
      status: 'approved',
      reasons: [],
      warningsByAccount: {},
      newTransactionCount: 2,
      period: { from: '2026-01-01', to: '2026-01-31' },
    };
    const outcome = (over: Record<string, unknown>) => ({
      fileId: 'file-1',
      status: 'approved',
      reasons: [],
      warningsByAccount: {},
      redelivered: false,
      report,
      ...over,
    });

    beforeEach(() => {
      publishCommittedOutcome.mockReset().mockResolvedValue(true);
      publishDueOutcomes.mockReset().mockResolvedValue(0);
      sendOutcome.mockReset().mockResolvedValue(undefined);
      process.env['OUTCOME_QUEUE_URL'] = 'https://sqs.example/outcomes';
    });
    afterEach(() => {
      delete process.env['OUTCOME_QUEUE_URL'];
    });

    const run = async () => {
      const { handler } = await import('./handler');
      return handler(sqsEvent(upload), {} as never, () => undefined);
    };

    it('publishes a committed outcome and sweeps earlier unpublished ones', async () => {
      processStatementFile.mockResolvedValueOnce(outcome({}));

      await run();

      expect(publishCommittedOutcome).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'https://sqs.example/outcomes',
        report,
      );
      expect(publishDueOutcomes).toHaveBeenCalledTimes(1);
    });

    it('does not fail the upload message when the publish fails (the sweeper delivers it)', async () => {
      processStatementFile.mockResolvedValueOnce(outcome({}));
      publishCommittedOutcome.mockResolvedValueOnce(false);

      await expect(run()).resolves.not.toThrow();
    });

    it('publishes an unrecorded rejection directly, and fails the message if that fails', async () => {
      const unrecorded = outcome({
        fileId: null,
        status: 'rejected',
        report: { ...report, fileId: null, status: 'rejected' },
      });
      processStatementFile.mockResolvedValueOnce(unrecorded);
      await run();
      expect(sendOutcome).toHaveBeenCalledTimes(1);
      expect(publishCommittedOutcome).not.toHaveBeenCalled();

      processStatementFile.mockResolvedValueOnce(unrecorded);
      sendOutcome.mockRejectedValueOnce(new Error('sqs down'));
      await expect(run()).rejects.toThrow('sqs down');
    });

    it('publishes nothing for a redelivery but still sweeps', async () => {
      processStatementFile.mockResolvedValueOnce(
        outcome({ redelivered: true, report: null }),
      );

      await run();

      expect(publishCommittedOutcome).not.toHaveBeenCalled();
      expect(sendOutcome).not.toHaveBeenCalled();
      expect(publishDueOutcomes).toHaveBeenCalledTimes(1);
    });

    it('does not fail the batch when the sweep fails', async () => {
      processStatementFile.mockResolvedValueOnce(outcome({}));
      publishDueOutcomes.mockRejectedValueOnce(new Error('db down'));

      await expect(run()).resolves.not.toThrow();
    });

    it('publishes nothing while no outcome queue is configured', async () => {
      delete process.env['OUTCOME_QUEUE_URL'];
      processStatementFile.mockResolvedValueOnce(outcome({}));

      await run();

      expect(publishCommittedOutcome).not.toHaveBeenCalled();
      expect(publishDueOutcomes).not.toHaveBeenCalled();
    });
  });
});
