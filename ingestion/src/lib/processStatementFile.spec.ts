import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  EmptyStatementFileError,
  MissingUploadAccountError,
  OversizedStatementFileError,
  processStatementFile,
  UnresolvableRowIbanError,
  type ParserDispatch,
} from './processStatementFile';
import type { DataApiConfig } from './dataApi';
import type { NormalizedRow } from './parsers/types';

const dataApiConfig: DataApiConfig = {
  resourceArn: 'arn:aws:rds:eu-north-1:123:cluster:test',
  secretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:test',
  database: 'draupnir',
};

interface FakeAccountRow {
  id: string;
  bank: string;
  iban: string;
}

function paramValue(value: unknown): unknown {
  const field = value as {
    stringValue?: string;
    doubleValue?: number;
    booleanValue?: boolean;
    isNull?: boolean;
  };
  if (field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  return undefined;
}

function fakeDataApiClient(options: {
  accountsById: Record<string, FakeAccountRow | undefined>;
  accountsByIban: Record<string, { id: string } | undefined>;
  onInsert?: (params: Record<string, unknown>) => void;
}) {
  const send = vi.fn(async (command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor
      .name;

    if (name === 'BeginTransactionCommand') {
      return { transactionId: 'tx-1' };
    }
    if (name === 'CommitTransactionCommand' || name === 'RollbackTransactionCommand') {
      return {};
    }
    if (name === 'ExecuteStatementCommand') {
      const input = (
        command as {
          input: {
            sql: string;
            parameters: { name: string; value: unknown }[];
          };
        }
      ).input;
      const params = Object.fromEntries(
        input.parameters.map((p) => [p.name, paramValue(p.value)]),
      );

      if (input.sql.includes('FROM accounts WHERE id =')) {
        const row = options.accountsById[params['accountId'] as string];
        return {
          formattedRecords: JSON.stringify(row ? [row] : []),
          numberOfRecordsUpdated: 0,
        };
      }
      if (input.sql.includes('FROM accounts WHERE iban =')) {
        const row = options.accountsByIban[params['iban'] as string];
        return {
          formattedRecords: JSON.stringify(row ? [row] : []),
          numberOfRecordsUpdated: 0,
        };
      }
      if (input.sql.includes('INSERT INTO transactions')) {
        options.onInsert?.(params);
        return { numberOfRecordsUpdated: 1 };
      }
    }
    if (name === 'BatchExecuteStatementCommand') {
      const input = (
        command as {
          input: {
            sql: string;
            parameterSets: { name: string; value: unknown }[][];
          };
        }
      ).input;

      if (input.sql.includes('INSERT INTO transactions')) {
        for (const parameterSet of input.parameterSets) {
          options.onInsert?.(
            Object.fromEntries(
              parameterSet.map((p) => [p.name, paramValue(p.value)]),
            ),
          );
        }
        return { updateResults: [] };
      }
    }
    throw new Error(`unexpected command: ${name}`);
  });

  return send;
}

function fakeS3Client(fileContents: string, contentLength?: number): S3Client {
  const send = vi.fn().mockResolvedValue({
    Body: { transformToString: async () => fileContents },
    ContentLength: contentLength,
  });
  return { send } as unknown as S3Client;
}

function row(overrides: Partial<NormalizedRow> = {}): NormalizedRow {
  return {
    iban: 'LT100000000000000001',
    postedDate: '2026-08-29',
    amountMinorUnits: -1000,
    currency: 'EUR',
    description: 'lidl',
    dedupKey: 'seb:1',
    ...overrides,
  };
}

describe('processStatementFile', () => {
  it('writes every parsed row inside one transaction', async () => {
    const inserted: Record<string, unknown>[] = [];
    const send = fakeDataApiClient({
      accountsById: {
        'acc-1': { id: 'acc-1', bank: 'seb', iban: 'LT100000000000000001' },
      },
      accountsByIban: {
        LT100000000000000001: { id: 'acc-1' },
      },
      onInsert: (params) => inserted.push(params),
    });
    const client = { send } as unknown as RDSDataClient;
    const s3Client = fakeS3Client('raw file contents');
    const parsers: ParserDispatch = {
      seb: vi.fn().mockReturnValue([
        row({ dedupKey: 'seb:1' }),
        row({ dedupKey: 'seb:2' }),
      ]),
    };

    await processStatementFile(
      client,
      dataApiConfig,
      s3Client,
      parsers,
      'draupnir-uploads',
      'uploads/user-1/acc-1/file.csv',
      1000,
    );

    expect(inserted).toHaveLength(2);
    expect(inserted.map((p) => p['dedupKey'])).toEqual(['seb:1', 'seb:2']);
    expect(inserted.every((p) => p['accountId'] === 'acc-1')).toBe(true);
    expect(parsers['seb']).toHaveBeenCalledWith(
      'raw file contents',
      'LT100000000000000001',
    );
  });

  it('sends posted_date with a DATE typeHint so BatchExecuteStatement does not reject it as text', async () => {
    // Regression test: BatchExecuteStatement (unlike ExecuteStatement) does
    // not implicitly cast a plain stringValue to a `date` column — verified
    // against a live cluster, where this failed with "column is of type
    // date but expression is of type text" before dataApi.ts's
    // dateParameter() added an explicit typeHint.
    const send = fakeDataApiClient({
      accountsById: {
        'acc-1': { id: 'acc-1', bank: 'seb', iban: 'LT100000000000000001' },
      },
      accountsByIban: {
        LT100000000000000001: { id: 'acc-1' },
      },
    });
    const client = { send } as unknown as RDSDataClient;
    const s3Client = fakeS3Client('raw file contents');
    const parsers: ParserDispatch = {
      seb: vi.fn().mockReturnValue([row({ dedupKey: 'seb:1' })]),
    };

    await processStatementFile(
      client,
      dataApiConfig,
      s3Client,
      parsers,
      'draupnir-uploads',
      'uploads/user-1/acc-1/file.csv',
      1000,
    );

    const batchCall = send.mock.calls.find(
      ([command]) =>
        (command as { constructor: { name: string } }).constructor.name ===
        'BatchExecuteStatementCommand',
    );
    const parameterSets = (
      batchCall?.[0] as {
        input: { parameterSets: { name: string; typeHint?: string }[][] };
      }
    ).input.parameterSets;
    const postedDateParam = parameterSets[0]?.find(
      (p) => p.name === 'postedDate',
    );
    expect(postedDateParam?.typeHint).toBe('DATE');
  });

  it('writes FX metadata when present, and null when absent', async () => {
    const inserted: Record<string, unknown>[] = [];
    const send = fakeDataApiClient({
      accountsById: {
        'acc-1': { id: 'acc-1', bank: 'seb', iban: 'LT100000000000000001' },
      },
      accountsByIban: {
        LT100000000000000001: { id: 'acc-1' },
      },
      onInsert: (params) => inserted.push(params),
    });
    const client = { send } as unknown as RDSDataClient;
    const s3Client = fakeS3Client('raw file contents');
    const parsers: ParserDispatch = {
      seb: vi.fn().mockReturnValue([
        row({
          dedupKey: 'seb:1',
          originalCurrency: 'NOK',
          originalAmountMinorUnits: -29900,
          fxFeeMinorUnits: 68,
          fxFeePercent: 2.65,
        }),
        row({ dedupKey: 'seb:2' }),
      ]),
    };

    await processStatementFile(
      client,
      dataApiConfig,
      s3Client,
      parsers,
      'draupnir-uploads',
      'uploads/user-1/acc-1/file.csv',
      1000,
    );

    const byDedupKey = Object.fromEntries(
      inserted.map((p) => [p['dedupKey'], p]),
    );
    expect(byDedupKey['seb:1']).toMatchObject({
      originalCurrency: 'NOK',
      originalAmountMinorUnits: -29900,
      fxFeeMinorUnits: 68,
      fxFeePercent: 2.65,
    });
    expect(byDedupKey['seb:2']).toMatchObject({
      originalCurrency: null,
      originalAmountMinorUnits: null,
      fxFeeMinorUnits: null,
      fxFeePercent: null,
    });
  });

  it('leaves no rows committed when parsing fails partway', async () => {
    const inserted: Record<string, unknown>[] = [];
    const send = fakeDataApiClient({
      accountsById: {
        'acc-1': { id: 'acc-1', bank: 'seb', iban: 'LT100000000000000001' },
      },
      accountsByIban: {},
      onInsert: (params) => inserted.push(params),
    });
    const client = { send } as unknown as RDSDataClient;
    const s3Client = fakeS3Client('raw file contents');
    const parsers: ParserDispatch = {
      seb: vi.fn().mockImplementation(() => {
        throw new Error('malformed row 3');
      }),
    };

    await expect(
      processStatementFile(
        client,
        dataApiConfig,
        s3Client,
        parsers,
        'draupnir-uploads',
        'uploads/user-1/acc-1/file.csv',
        1000,
      ),
    ).rejects.toThrow('malformed row 3');

    expect(inserted).toHaveLength(0);
  });

  it('rejects a file that parses to zero transaction rows, without starting a transaction', async () => {
    const send = fakeDataApiClient({
      accountsById: {
        'acc-1': { id: 'acc-1', bank: 'seb', iban: 'LT100000000000000001' },
      },
      accountsByIban: {},
    });
    const client = { send } as unknown as RDSDataClient;
    const s3Client = fakeS3Client('raw file contents');
    const parsers: ParserDispatch = { seb: vi.fn().mockReturnValue([]) };

    await expect(
      processStatementFile(
        client,
        dataApiConfig,
        s3Client,
        parsers,
        'draupnir-uploads',
        'uploads/user-1/acc-1/file.csv',
        1000,
      ),
    ).rejects.toThrow(EmptyStatementFileError);

    const commandNames = send.mock.calls.map(
      ([command]) => (command as { constructor: { name: string } }).constructor.name,
    );
    expect(commandNames).not.toContain('BeginTransactionCommand');
  });

  it('fails when the upload-selected account no longer exists', async () => {
    const send = fakeDataApiClient({ accountsById: {}, accountsByIban: {} });
    const client = { send } as unknown as RDSDataClient;
    const s3Client = fakeS3Client('raw file contents');
    const parsers: ParserDispatch = { seb: vi.fn() };

    await expect(
      processStatementFile(
        client,
        dataApiConfig,
        s3Client,
        parsers,
        'draupnir-uploads',
        'uploads/user-1/acc-1/file.csv',
        1000,
      ),
    ).rejects.toThrow(MissingUploadAccountError);
    expect(parsers['seb']).not.toHaveBeenCalled();
  });

  it('rejects an oversized file before touching S3 or the database', async () => {
    const send = fakeDataApiClient({ accountsById: {}, accountsByIban: {} });
    const client = { send } as unknown as RDSDataClient;
    const s3Send = vi.fn();
    const s3Client = { send: s3Send } as unknown as S3Client;
    const parsers: ParserDispatch = { seb: vi.fn() };

    await expect(
      processStatementFile(
        client,
        dataApiConfig,
        s3Client,
        parsers,
        'draupnir-uploads',
        'uploads/user-1/acc-1/file.csv',
        11 * 1024 * 1024,
      ),
    ).rejects.toThrow(OversizedStatementFileError);

    expect(send).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('rejects a file whose actual GetObject size exceeds the limit, even when the S3 event size did not', async () => {
    const send = fakeDataApiClient({
      accountsById: {
        'acc-1': { id: 'acc-1', bank: 'seb', iban: 'LT100000000000000001' },
      },
      accountsByIban: {},
    });
    const client = { send } as unknown as RDSDataClient;
    const transformToString = vi.fn(async () => 'raw file contents');
    const s3Send = vi.fn().mockResolvedValue({
      Body: { transformToString },
      ContentLength: 11 * 1024 * 1024,
    });
    const s3Client = { send: s3Send } as unknown as S3Client;
    const parsers: ParserDispatch = { seb: vi.fn() };

    await expect(
      processStatementFile(
        client,
        dataApiConfig,
        s3Client,
        parsers,
        'draupnir-uploads',
        'uploads/user-1/acc-1/file.csv',
        1000,
      ),
    ).rejects.toThrow(OversizedStatementFileError);

    expect(transformToString).not.toHaveBeenCalled();
    expect(parsers['seb']).not.toHaveBeenCalled();
    const commandNames = send.mock.calls.map(
      ([command]) => (command as { constructor: { name: string } }).constructor.name,
    );
    expect(commandNames).not.toContain('BeginTransactionCommand');
  });

  it('fails the whole file when a parsed row iban does not resolve to an account', async () => {
    const inserted: Record<string, unknown>[] = [];
    const send = fakeDataApiClient({
      accountsById: {
        'acc-1': { id: 'acc-1', bank: 'seb', iban: 'LT100000000000000001' },
      },
      accountsByIban: {
        LT100000000000000001: { id: 'acc-1' },
        // LT...999 deliberately missing — no account for that row's iban
      },
      onInsert: (params) => inserted.push(params),
    });
    const client = { send } as unknown as RDSDataClient;
    const s3Client = fakeS3Client('raw file contents');
    const parsers: ParserDispatch = {
      seb: vi.fn().mockReturnValue([
        row({ iban: 'LT100000000000000001', dedupKey: 'seb:1' }),
        row({ iban: 'LT100000000000000999', dedupKey: 'seb:2' }),
      ]),
    };

    await expect(
      processStatementFile(
        client,
        dataApiConfig,
        s3Client,
        parsers,
        'draupnir-uploads',
        'uploads/user-1/acc-1/file.csv',
        1000,
      ),
    ).rejects.toThrow(UnresolvableRowIbanError);

    expect(inserted).toHaveLength(0);
  });

  it('resolves each row to its own account in a multi-account file', async () => {
    const inserted: Record<string, unknown>[] = [];
    const send = fakeDataApiClient({
      accountsById: {
        'acc-1': { id: 'acc-1', bank: 'seb', iban: 'LT100000000000000001' },
      },
      accountsByIban: {
        LT100000000000000001: { id: 'acc-1' },
        LT100000000000000002: { id: 'acc-2' },
      },
      onInsert: (params) => inserted.push(params),
    });
    const client = { send } as unknown as RDSDataClient;
    const s3Client = fakeS3Client('raw file contents');
    const parsers: ParserDispatch = {
      seb: vi.fn().mockReturnValue([
        row({ iban: 'LT100000000000000001', dedupKey: 'seb:1' }),
        row({ iban: 'LT100000000000000002', dedupKey: 'seb:2' }),
      ]),
    };

    await processStatementFile(
      client,
      dataApiConfig,
      s3Client,
      parsers,
      'draupnir-uploads',
      'uploads/user-1/acc-1/file.csv',
      1000,
    );

    expect(inserted).toHaveLength(2);
    const byDedupKey = Object.fromEntries(
      inserted.map((p) => [p['dedupKey'], p['accountId']]),
    );
    expect(byDedupKey['seb:1']).toBe('acc-1');
    expect(byDedupKey['seb:2']).toBe('acc-2');
  });
});
