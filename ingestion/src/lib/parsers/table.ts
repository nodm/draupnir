import { parseCsv } from '../csv';

export interface TableRecord {
  rowNumber: number;
  cells: string[];
}

export interface Table {
  headers: string[];
  records: TableRecord[];
}

export class UnrecognizedFormatError extends Error {
  constructor(detail: string) {
    super(`Unrecognized statement format: ${detail}`);
    this.name = 'UnrecognizedFormatError';
  }
}

// Zips a record's cells with the header into the raw payload. Cells are kept
// byte-for-byte; a duplicate header would silently overwrite, so callers must
// reject duplicate headers (see `duplicateHeaders`) before building payloads.
export function toPayload(
  headers: readonly string[],
  cells: readonly string[],
): Record<string, string> {
  const payload: Record<string, string> = {};
  headers.forEach((header, index) => {
    payload[header] = cells[index] ?? '';
  });
  return payload;
}

export function duplicateHeaders(headers: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const header of headers) {
    if (seen.has(header)) duplicates.add(header);
    seen.add(header);
  }
  return [...duplicates];
}

// Single-header-line formats (Revolut, monobank): the first non-empty line is
// the header, every following non-empty line is a data row.
export function readSimpleTable(
  fileContents: string,
  delimiter: string,
): Table {
  const lines = parseCsv(fileContents.replace(/^\uFEFF/, ''), delimiter);
  const [headers, ...rows] = lines;
  if (!headers) {
    throw new UnrecognizedFormatError('file is empty');
  }
  return {
    headers,
    records: rows.map((cells, index) => ({ rowNumber: index + 1, cells })),
  };
}
