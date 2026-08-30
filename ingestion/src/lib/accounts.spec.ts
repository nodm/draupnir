import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  createAccount,
  DuplicateIbanError,
  InvalidAccountInputError,
  InvalidBankError,
} from './accounts';
import { UnauthenticatedError } from './auth';
import type { DataApiConfig } from './dataApi';

const config: DataApiConfig = {
  resourceArn: 'arn:aws:rds:eu-north-1:123:cluster:test',
  secretArn: 'arn:aws:secretsmanager:eu-north-1:123:secret:test',
  database: 'draupnir',
};

function fakeClient(
  send: (command: unknown) => Promise<unknown>,
): RDSDataClient {
  return { send } as unknown as RDSDataClient;
}

const validInput = {
  bank: 'seb',
  iban: 'LT100000000000000001',
  currency: 'EUR',
  displayName: 'SEB checking',
};

describe('createAccount', () => {
  it('creates an account owned by the caller sub', async () => {
    const send = vi.fn().mockResolvedValue({ numberOfRecordsUpdated: 1 });

    const account = await createAccount(
      fakeClient(send),
      config,
      { sub: 'user-123' },
      validInput,
    );

    expect(account).toEqual({
      id: expect.any(String),
      ...validInput,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0];
    const parameterNames = command.input.parameters.map(
      (p: { name: string }) => p.name,
    );
    expect(parameterNames).toContain('ownerUserId');
    const ownerParam = command.input.parameters.find(
      (p: { name: string }) => p.name === 'ownerUserId',
    );
    expect(ownerParam.value).toEqual({ stringValue: 'user-123' });
  });

  it('rejects when the caller has no sub claim', async () => {
    const send = vi.fn();

    await expect(
      createAccount(fakeClient(send), config, {}, validInput),
    ).rejects.toThrow(UnauthenticatedError);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an unknown bank value without querying the database', async () => {
    const send = vi.fn();

    await expect(
      createAccount(
        fakeClient(send),
        config,
        { sub: 'user-123' },
        { ...validInput, bank: 'chase' },
      ),
    ).rejects.toThrow(InvalidBankError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['iban', 'currency', 'displayName'] as const)(
    'rejects an empty %s without querying the database',
    async (field) => {
      const send = vi.fn();

      await expect(
        createAccount(
          fakeClient(send),
          config,
          { sub: 'user-123' },
          { ...validInput, [field]: '  ' },
        ),
      ).rejects.toThrow(InvalidAccountInputError);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('rejects a duplicate iban', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'duplicate key value violates unique constraint "accounts_iban_key"',
        ),
      );

    await expect(
      createAccount(fakeClient(send), config, { sub: 'user-123' }, validInput),
    ).rejects.toThrow(DuplicateIbanError);
  });
});
