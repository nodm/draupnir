import { randomUUID } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { BANKS, type Bank } from 'shared';
import { requireSub } from './auth';
import { executeStatement, type DataApiConfig } from './dataApi';

export interface CreateAccountInput {
  bank: string;
  iban: string;
  currency: string;
  displayName: string;
}

export interface CreatedAccount {
  id: string;
  bank: Bank;
  iban: string;
  currency: string;
  displayName: string;
}

export class InvalidBankError extends Error {
  constructor(bank: string) {
    super(`Unknown bank: ${bank}`);
    this.name = 'InvalidBankError';
  }
}

export class DuplicateIbanError extends Error {
  constructor() {
    super('An account with this iban already exists');
    this.name = 'DuplicateIbanError';
  }
}

function isBank(value: string): value is Bank {
  return (BANKS as readonly string[]).includes(value);
}

export async function createAccount(
  client: RDSDataClient,
  config: DataApiConfig,
  claims: { [name: string]: string },
  input: CreateAccountInput,
): Promise<CreatedAccount> {
  const sub = requireSub(claims);
  if (!isBank(input.bank)) {
    throw new InvalidBankError(input.bank);
  }

  const id = randomUUID();

  try {
    await executeStatement(
      client,
      config,
      `INSERT INTO accounts (id, owner_user_id, bank, iban, currency, display_name)
       VALUES (:id, :ownerUserId, :bank, :iban, :currency, :displayName)`,
      {
        id,
        ownerUserId: sub,
        bank: input.bank,
        iban: input.iban,
        currency: input.currency,
        displayName: input.displayName,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('duplicate key')) {
      throw new DuplicateIbanError();
    }
    throw error;
  }

  return {
    id,
    bank: input.bank,
    iban: input.iban,
    currency: input.currency,
    displayName: input.displayName,
  };
}
