import type { SQSEvent } from 'aws-lambda';

const dispatch = vi.fn();

vi.mock('./lib/dispatcher', () => ({
  dispatch: (...args: unknown[]) => dispatch(...args),
}));
vi.mock('./lib/secrets', () => ({ getSecretString: async () => 'token' }));
vi.mock('./lib/telegram', () => ({ createTelegramClient: () => ({}) }));
vi.mock('./lib/retention/retention', () => ({
  createRetention: () => ({}),
  withRetention: (telegram: unknown) => telegram,
}));
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
vi.mock('./lib/commands/accounts', () => ({
  COVERAGE_CALLBACK_PREFIX: 'cov',
  createAccountsHandler: vi.fn(),
  createCoverageHandler: vi.fn(),
  handleCoverageCallback: vi.fn(),
}));
vi.mock('./lib/commands/newAccount', () => ({
  BANK_CALLBACK_PREFIX: 'nb',
  CONFIRM_CALLBACK_PREFIX: 'nc',
  createCancelHandler: vi.fn(),
  createNewAccountHandler: vi.fn(),
  handleNewAccountCallback: vi.fn(),
  handleNewAccountText: vi.fn(),
}));
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class {},
}));
vi.mock('./lib/directory', () => ({ createCognitoDirectory: () => ({}) }));
vi.mock('./lib/commands/share', () => ({
  SHARE_ACCOUNT_PREFIX: 'sa',
  SHARE_ROLE_PREFIX: 'sr',
  UNSHARE_ACCOUNT_PREFIX: 'ua',
  UNSHARE_MEMBER_PREFIX: 'um',
  createShareHandler: vi.fn(),
  createUnshareHandler: vi.fn(),
  handleSharingCallback: vi.fn(),
  handleSharingText: vi.fn(),
}));
vi.mock('./lib/commands/unlink', () => ({ createUnlinkHandler: vi.fn() }));
vi.mock('./lib/linking/config', () => ({ loadLinkConfigFromEnv: () => ({}) }));
vi.mock('./lib/linking/linkStore', () => ({ createLinkStore: () => ({}) }));
vi.mock('./lib/linking/unlinked', () => ({ handleUnlinked: vi.fn() }));
vi.mock('shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('shared')>()),
  loadDataApiConfigFromEnv: () => ({}),
}));
const reportOutcome = vi.fn();
vi.mock('./lib/outcomes/reportOutcome', () => ({
  reportOutcome: (...args: unknown[]) => reportOutcome(...args),
}));
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
    reportOutcome.mockReset();
    process.env['BOT_TOKEN_SECRET_ARN'] = 'arn:token';
    process.env['LINK_STATE_SECRET_ARN'] = 'arn:link-state';
    process.env['UPLOADS_BUCKET'] = 'bucket';
    process.env['USER_POOL_ID'] = 'pool';
  });

  it('processes every record in order and reports no failures', async () => {
    const { handler } = await import('./worker');
    const result = await handler(event('1', '2'), {} as never, () => undefined);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('does not need the user pool unless /share or /unshare runs', async () => {
    delete process.env['USER_POOL_ID'];
    const { handler } = await import('./worker');
    const result = await handler(event('1'), {} as never, () => undefined);

    expect(dispatch).toHaveBeenCalledTimes(1);
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

  it('sends a statement outcome to the reporter, not the Telegram dispatcher', async () => {
    const outcome = {
      fileId: 'f1',
      s3Key: 'uploads/u/a/1.csv',
      sub: 'u',
      status: 'approved',
      reasons: [],
      warningsByAccount: {},
      newTransactionCount: 1,
      period: null,
    };
    const { handler } = await import('./worker');
    const result = await handler(
      { Records: [{ messageId: '9', body: JSON.stringify(outcome) }] } as never,
      {} as never,
      () => undefined,
    );

    expect(reportOutcome).toHaveBeenCalledWith(outcome, expect.anything());
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('retries an outcome whose report failed, like any other record', async () => {
    reportOutcome.mockRejectedValueOnce(new Error('telegram down'));
    const { handler } = await import('./worker');
    const result = await handler(
      {
        Records: [
          {
            messageId: '9',
            body: JSON.stringify({
              fileId: null,
              s3Key: 'k',
              sub: 'u',
              status: 'rejected',
              reasons: [],
              warningsByAccount: {},
              newTransactionCount: 0,
              period: null,
            }),
          },
        ],
      } as never,
      {} as never,
      () => undefined,
    );

    expect(reportOutcome).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '9' }] });
  });

  it('treats a half-formed outcome as a Telegram update, never as an outcome', async () => {
    const { handler } = await import('./worker');
    await handler(
      {
        Records: [
          {
            messageId: '3',
            body: JSON.stringify({
              s3Key: 'k',
              sub: 'u',
              status: 'rejected',
              reasons: [],
            }),
          },
        ],
      } as never,
      {} as never,
      () => undefined,
    );

    expect(reportOutcome).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
