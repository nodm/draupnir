import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  BANKS,
  dateParameter,
  executeStatement,
  withCaller,
  type Bank,
  type DataApiConfig,
} from 'shared';
import { requireSub } from './auth';

export interface CreateAccountInput {
  bank: string;
  iban: string;
  currency: string;
  displayName: string;
  // YYYY-MM-DD, and the balance on that date in minor units; entered once at
  // creation and the anchor for checking that imported history is complete.
  openedOn: string;
  openingBalanceMinorUnits: number;
}

export interface CreatedAccount {
  id: string;
  bank: Bank;
  iban: string;
  currency: string;
  displayName: string;
  openedOn: string;
  openingBalanceMinorUnits: number;
}

export class InvalidBankError extends Error {
  constructor(bank: string) {
    super(`Unknown bank: ${bank}`);
    this.name = 'InvalidBankError';
  }
}

export class DuplicateIbanError extends Error {
  constructor() {
    super(
      'An account with this iban already exists; ask one of its owners to add you as a member',
    );
    this.name = 'DuplicateIbanError';
  }
}

export class InvalidAccountInputError extends Error {
  constructor(field: string) {
    super(`${field} is missing or invalid`);
    this.name = 'InvalidAccountInputError';
  }
}

function isBank(value: string): value is Bank {
  return (BANKS as readonly string[]).includes(value);
}

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Canonical form so the UNIQUE constraint and the parsers' resolution
// per-row resolution query (owner membership + iban) can't be bypassed by casing/whitespace —
// e.g. SEB statements carry uppercase, unspaced IBANs, so an account
// created with lowercase or spaced input would never resolve a row.
function canonicalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

// 2-letter country + 2 check digits + 11-30 char BBAN = ISO 13616's 15-34
// total length range.
const IBAN_SHAPE_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

// ISO 13616 mod-97 checksum: move the country+check-digit prefix to the
// end, expand each letter to two digits (A=10..Z=35), and the resulting
// number mod 97 must equal 1. Catches e.g. all-zero or transposed-digit
// IBANs that the shape pattern alone lets through — those can never match
// a real statement row but would still occupy the unique iban value.
function hasValidIbanChecksum(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (letter) =>
    String(letter.charCodeAt(0) - 55),
  );
  return BigInt(numeric) % BigInt(97) === BigInt(1);
}

export async function createAccount(
  client: RDSDataClient,
  config: DataApiConfig,
  claims: { [name: string]: string },
  input: CreateAccountInput,
): Promise<CreatedAccount> {
  const sub = requireSub(claims);
  if (!isNonEmptyString(input.bank)) {
    throw new InvalidAccountInputError('bank');
  }
  if (!isBank(input.bank)) {
    throw new InvalidBankError(input.bank);
  }
  if (!isNonEmptyString(input.iban)) {
    throw new InvalidAccountInputError('iban');
  }
  const iban = canonicalizeIban(input.iban);
  if (!IBAN_SHAPE_PATTERN.test(iban) || !hasValidIbanChecksum(iban)) {
    throw new InvalidAccountInputError('iban');
  }
  if (!isNonEmptyString(input.currency)) {
    throw new InvalidAccountInputError('currency');
  }
  // Statements carry uppercase ISO 4217 codes and imports compare them
  // literally, so store the canonical form; 'eur' / ' EUR ' would otherwise
  // create an account no import could ever match.
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new InvalidAccountInputError('currency');
  }
  if (!isNonEmptyString(input.displayName)) {
    throw new InvalidAccountInputError('displayName');
  }

  if (!isValidIsoDate(input.openedOn)) {
    throw new InvalidAccountInputError('openedOn');
  }
  if (!Number.isSafeInteger(input.openingBalanceMinorUnits)) {
    throw new InvalidAccountInputError('openingBalanceMinorUnits');
  }

  // The account and its owner membership are created together by one
  // SECURITY DEFINER function: the app role has no INSERT on accounts.
  let id: string;
  try {
    id = await withCaller(client, config, sub, async (transactionId) => {
      const { rows } = await executeStatement(
        client,
        config,
        `SELECT draupnir.create_account(:bank, :iban, :currency, :displayName, CAST(:openedOn AS date), CAST(:openingBalance AS bigint)) AS id`,
        {
          bank: input.bank,
          iban,
          currency,
          displayName: input.displayName,
          openedOn: dateParameter(input.openedOn),
          openingBalance: input.openingBalanceMinorUnits,
        },
        transactionId,
      );
      return (rows[0] as { id: string }).id;
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('duplicate key')) {
      throw new DuplicateIbanError();
    }
    throw error;
  }

  return {
    id,
    bank: input.bank,
    iban,
    currency,
    displayName: input.displayName,
    openedOn: input.openedOn,
    openingBalanceMinorUnits: input.openingBalanceMinorUnits,
  };
}
