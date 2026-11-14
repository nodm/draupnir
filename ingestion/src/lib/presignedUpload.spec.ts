import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { S3Client } from '@aws-sdk/client-s3';
import { AccountNotFoundError, createPresignedUpload } from './presignedUpload';
import { UnauthenticatedError } from './auth';
import type { DataApiConfig } from 'shared';

const dataApiConfig: DataApiConfig = {
  resourceArn: 'arn:aws:rds:eu-north-1:123:cluster:test',
  secretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:test',
  database: 'draupnir',
};

const bucketConfig = { bucket: 'draupnir-uploads' };

// withCaller wraps every query in begin / set identity / commit; those calls are
// answered here so `send` only sees the query under test.
function fakeDataApiClient(
  send: (command: unknown) => Promise<unknown>,
): RDSDataClient {
  return {
    send: (command: { constructor: { name: string }; input: object }) => {
      switch (command.constructor.name) {
        case 'BeginTransactionCommand':
          return Promise.resolve({ transactionId: 'tx' });
        case 'CommitTransactionCommand':
        case 'RollbackTransactionCommand':
          return Promise.resolve({});
        default:
          return (command.input as { sql?: string }).sql?.includes('set_config')
            ? Promise.resolve({})
            : send(command);
      }
    },
  } as unknown as RDSDataClient;
}

function rowsResponse(rows: unknown[]) {
  return { formattedRecords: JSON.stringify(rows) };
}

// The real signer, offline: static fake credentials and a fixed region, so the
// test checks the policy S3 will enforce rather than arguments to a mock.
const s3Client = new S3Client({
  region: 'eu-north-1',
  credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' },
});

type PolicyCondition = Record<string, string> | (string | number)[];

function decodePolicy(fields: Record<string, string>): {
  expiration: string;
  conditions: PolicyCondition[];
} {
  return JSON.parse(
    Buffer.from(fields['Policy'] as string, 'base64').toString('utf8'),
  );
}

describe('createPresignedUpload', () => {
  it('issues a presigned POST scoped to the caller sub and the owned account', async () => {
    const send = vi.fn().mockResolvedValue(rowsResponse([{ role: 'owner' }]));

    const result = await createPresignedUpload(
      fakeDataApiClient(send),
      dataApiConfig,
      s3Client,
      bucketConfig,
      { sub: 'user-123' },
      { accountId: 'acc-1' },
    );

    expect(Object.keys(result).sort()).toEqual(['fields', 'url']);
    expect(result.url).toContain('draupnir-uploads');
    expect(result.fields['key']).toMatch(
      /^uploads\/user-123\/acc-1\/[0-9a-f-]+\.csv$/,
    );
    expect(result.fields['Content-Type']).toBe('text/csv');

    const [command] = send.mock.calls[0];
    const params = Object.fromEntries(
      command.input.parameters.map((p: { name: string; value: unknown }) => [
        p.name,
        p.value,
      ]),
    );
    expect(params['accountId']).toEqual({ stringValue: 'acc-1' });
    expect(params['userId']).toEqual({ stringValue: 'user-123' });
    expect(command.input.sql).toContain('account_members');
  });

  it('signs a policy that limits size, key, content type and lifetime', async () => {
    const send = vi.fn().mockResolvedValue(rowsResponse([{ role: 'owner' }]));
    const before = Date.now();

    const { fields } = await createPresignedUpload(
      fakeDataApiClient(send),
      dataApiConfig,
      s3Client,
      bucketConfig,
      { sub: 'user-123' },
      { accountId: 'acc-1' },
    );

    const policy = decodePolicy(fields);
    expect(policy.conditions).toContainEqual([
      'content-length-range',
      1,
      10 * 1024 * 1024,
    ]);
    expect(policy.conditions).toContainEqual({ key: fields['key'] });
    expect(policy.conditions).toContainEqual({ bucket: 'draupnir-uploads' });
    expect(policy.conditions).toContainEqual([
      'eq',
      '$Content-Type',
      'text/csv',
    ]);
    const expiresInMs = Date.parse(policy.expiration) - before;
    expect(expiresInMs).toBeGreaterThan(14 * 60 * 1000);
    expect(expiresInMs).toBeLessThan(16 * 60 * 1000);
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

  it('rejects an account the caller only views', async () => {
    const send = vi.fn().mockResolvedValue(rowsResponse([{ role: 'viewer' }]));

    await expect(
      createPresignedUpload(
        fakeDataApiClient(send),
        dataApiConfig,
        s3Client,
        bucketConfig,
        { sub: 'user-123' },
        { accountId: 'shared-with-me' },
      ),
    ).rejects.toThrow(AccountNotFoundError);
  });

  it('rejects an account the caller is not a member of', async () => {
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
