import type { SQSEvent } from 'aws-lambda';

const processStatementFile = vi.fn().mockResolvedValue(undefined);

vi.mock('./lib/processStatementFile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/processStatementFile')>()),
  processStatementFile,
}));
vi.mock('./lib/dataApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/dataApi')>()),
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
      expect.anything(),
      'draupnir-uploads',
      'uploads/user-1/acc-1/file.csv',
      1234,
    );
  });
});
