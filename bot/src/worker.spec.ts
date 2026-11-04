import type { SQSEvent } from 'aws-lambda';

const dispatch = vi.fn();

vi.mock('./lib/dispatcher', () => ({
  dispatch: (...args: unknown[]) => dispatch(...args),
}));
vi.mock('./lib/secrets', () => ({ getSecretString: async () => 'token' }));
vi.mock('./lib/telegram', () => ({ createTelegramClient: () => ({}) }));
vi.mock('./lib/routes', () => ({
  createRoutes: () => ({}),
  createSubResolver: () => async () => null,
}));
vi.mock('./lib/upload/handleUpload', () => ({
  handleDocument: vi.fn(),
  handleUploadCallback: vi.fn(),
  UPLOAD_CALLBACK_PREFIX: 'up',
}));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class {} }));
vi.mock('./lib/commands/unlink', () => ({ createUnlinkHandler: vi.fn() }));
vi.mock('./lib/linking/config', () => ({ loadLinkConfigFromEnv: () => ({}) }));
vi.mock('./lib/linking/linkStore', () => ({ createLinkStore: () => ({}) }));
vi.mock('./lib/linking/unlinked', () => ({ handleUnlinked: vi.fn() }));
vi.mock('shared', () => ({ loadDataApiConfigFromEnv: () => ({}) }));
vi.mock('@aws-sdk/client-rds-data', () => ({ RDSDataClient: class {} }));

const record = (id: string) => ({
  messageId: id,
  body: JSON.stringify({ update_id: Number(id) }),
});
const event = (...ids: string[]) =>
  ({ Records: ids.map(record) }) as unknown as SQSEvent;

describe('bot worker', () => {
  beforeEach(() => {
    dispatch.mockReset();
    process.env['BOT_TOKEN_SECRET_ARN'] = 'arn:token';
    process.env['UPLOADS_BUCKET'] = 'bucket';
  });

  it('processes every record in order and reports no failures', async () => {
    const { handler } = await import('./worker');
    const result = await handler(event('1', '2'), {} as never, () => undefined);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('after a failure, reports it and every later record without running them', async () => {
    dispatch
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'));
    const { handler } = await import('./worker');
    const result = await handler(
      event('1', '2', '3'),
      {} as never,
      () => undefined,
    );

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: '2' }, { itemIdentifier: '3' }],
    });
  });
});
