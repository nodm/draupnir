import type { Bank } from 'shared';
import { parseStatement as parseMonobank } from '../parsers/monobank';
import { parseStatement as parseRevolut } from '../parsers/revolut';
import { parseStatement as parseSeb, readSebTable } from '../parsers/seb';
import {
  parseStatement as parseSwedbank,
  readSwedbankTable,
} from '../parsers/swedbank';
import {
  duplicateHeaders,
  readSimpleTable,
  toPayload,
  UnrecognizedFormatError,
  type Table,
} from '../parsers/table';
import type { ParsedStatement, StatementParser } from '../parsers/types';
import { checkBalanceChain, type BalanceChainResult } from './balanceChain';
import { detectFormat } from './formats';
import type { ValidationReason } from './types';

export const PARSERS: Record<Bank, StatementParser> = {
  seb: parseSeb,
  revolut: parseRevolut,
  monobank: parseMonobank,
  swedbank: parseSwedbank,
};

const DELIMITERS: Record<Bank, string> = {
  seb: ';',
  revolut: ',',
  monobank: ',',
  swedbank: ',',
};

export type FileValidation =
  | {
      ok: true;
      parsed: ParsedStatement;
      balances: BalanceChainResult['balancesByIban'];
    }
  | { ok: false; formatVersion: string | null; reasons: ValidationReason[] };

function readTable(
  bank: Bank,
  contents: string,
): { table: Table; extra: ValidationReason[] } {
  if (bank === 'seb') {
    const sebTable = readSebTable(contents);
    return { table: sebTable, extra: sebTable.malformed };
  }
  if (bank === 'swedbank') {
    const swedbankTable = readSwedbankTable(contents);
    return { table: swedbankTable, extra: swedbankTable.malformed };
  }
  return { table: readSimpleTable(contents, DELIMITERS[bank]), extra: [] };
}

// Everything that depends only on the file's own bytes: format, every row's
// cells, and the balance chain. Collects every reason rather than stopping at
// the first. Account-dependent rules (currency, ownership) and history-
// dependent rules (duplicate file, overlap, continuity) run later.
export function validateStatementFile(
  bank: Bank,
  fileContents: string,
  uploadAccountIban: string,
): FileValidation {
  let table: Table;
  const reasons: ValidationReason[] = [];
  try {
    const read = readTable(bank, fileContents);
    table = read.table;
    reasons.push(...read.extra);
  } catch (error) {
    const unrecognized = error instanceof UnrecognizedFormatError;
    return {
      ok: false,
      formatVersion: null,
      reasons: [
        {
          code: unrecognized ? 'unrecognized-format' : 'malformed-csv',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const duplicates = duplicateHeaders(table.headers);
  if (duplicates.length > 0) {
    return {
      ok: false,
      formatVersion: null,
      reasons: [
        ...reasons,
        {
          code: 'duplicate-header',
          message: `Duplicate column header: ${duplicates.join(', ')}`,
        },
      ],
    };
  }

  const format = detectFormat(bank, table.headers);
  if (!format) {
    return {
      ok: false,
      formatVersion: null,
      reasons: [
        ...reasons,
        {
          code: 'unrecognized-format',
          message: `Unrecognized ${bank} export format: the header matches no known format version`,
        },
      ],
    };
  }

  if (table.records.length === 0 && reasons.length === 0) {
    reasons.push({
      code: 'no-rows',
      message: 'The file contains no data rows',
    });
  }

  for (const { rowNumber, cells } of table.records) {
    if (cells.length !== table.headers.length) {
      reasons.push({
        code: 'malformed-row',
        row: rowNumber,
        message: `Row ${rowNumber}: expected ${table.headers.length} cells, got ${cells.length}`,
      });
      continue;
    }
    const payload = toPayload(table.headers, cells);
    const result = format.rowSchema.safeParse(
      format.schemaInput(payload, table.headers),
    );
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path.join('.');
        reasons.push({
          code: 'invalid-cell',
          row: rowNumber,
          message: `Row ${rowNumber}${field ? `, ${field}` : ''}: ${issue.message}`,
        });
      }
    }
  }

  if (reasons.length > 0) {
    return { ok: false, formatVersion: format.version, reasons };
  }

  let parsed: ParsedStatement;
  try {
    parsed = PARSERS[bank](fileContents, uploadAccountIban);
  } catch (error) {
    return {
      ok: false,
      formatVersion: format.version,
      reasons: [
        {
          code: 'parse-error',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const chain = checkBalanceChain(parsed);
  if (chain.reasons.length > 0) {
    return { ok: false, formatVersion: format.version, reasons: chain.reasons };
  }
  return { ok: true, parsed, balances: chain.balancesByIban };
}
