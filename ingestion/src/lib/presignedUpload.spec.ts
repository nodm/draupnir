import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AccountNotFoundError, createPresignedUpload } from './presignedUpload';
import { UnauthenticatedError } from './auth';
import type { DataApiConfig } from './dataApi';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

const dataApiConfig: DataApiConfig = {
  resourceArn: 'arn:aws:rds:eu-north-1:123:cluster:test',
  secretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:test',
  database: 'draupnir',
};

const bucketConfig = { bucket: 'draupnir-uploads' };

function fakeDataApiClient(
  send: (command: unknown) => Promise<unknown>,
): RDSDataClient {
  return { send } as unknown as RDSDataClient;
}

function rowsResponse(rows: unknown[]) {
  return { formattedRecords: JSON.stringify(rows) };
}

const s3Client = {} as S3Client;

describe('createPresignedUpload', () => {
  beforeEach(() => {
    vi.mocked(getSignedUrl).mockReset();
    vi.mocked(getSignedUrl).mockResolvedValue('https://s3.example/presigned');
  });

  it('issues a presigned URL scoped to the caller sub and the owned account', async () => {
    const send = vi.fn().mockResolvedValue(rowsResponse([{ id: 'acc-1' }]));

    const result = await createPresignedUpload(
      fakeDataApiClient(send),
      dataApiConfig,
      s3Client,
      bucketConfig,
      { sub: 'user-123' },
      { accountId: 'acc-1' },
    );

    expect(result.url).toBe('https://s3.example/presigned');
    expect(result.key).toMatch(
      /^uploads\/user-123\/acc-1\/[0-9a-f-]+\.csv$/,
    );
    expect(result.headers).toEqual({ 'If-None-Match': '*' });

    const [command] = send.mock.calls[0];
    const params = Object.fromEntries(
      command.input.parameters.map((p: { name: string; value: unknown }) => [
        p.name,
        p.value,
      ]),
    );
    expect(params['accountId']).toEqual({ stringValue: 'acc-1' });
    expect(params['ownerUserId']).toEqual({ stringValue: 'user-123' });

    const [, putCommand] = vi.mocked(getSignedUrl).mock.calls[0] as [
      unknown,
      { input: { IfNoneMatch?: string } },
    ];
    expect(putCommand.input.IfNoneMatch).toBe('*');
  });

  it('rejects when the caller has no sub claim', async () => {
    const send = vi.fn();

    await expect(
      createPresignedUpload(
        fakeDataApiClient(send),
        dataApiConfig,
        s3Client,
        bucketConfig,
        {},
        { accountId: 'acc-1' },
      ),
    ).rejects.toThrow(UnauthenticatedError);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an account owned by another user', async () => {
    const send = vi.fn().mockResolvedValue(rowsResponse([]));

    await expect(
      createPresignedUpload(
        fakeDataApiClient(send),
        dataApiConfig,
        s3Client,
        bucketConfig,
        { sub: 'user-123' },
        { accountId: 'someone-elses-account' },
      ),
    ).rejects.toThrow(AccountNotFoundError);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('rejects a nonexistent account', async () => {
    const send = vi.fn().mockResolvedValue(rowsResponse([]));

    await expect(
      createPresignedUpload(
        fakeDataApiClient(send),
        dataApiConfig,
        s3Client,
        bucketConfig,
        { sub: 'user-123' },
        { accountId: 'does-not-exist' },
      ),
    ).rejects.toThrow(AccountNotFoundError);
  });
});
