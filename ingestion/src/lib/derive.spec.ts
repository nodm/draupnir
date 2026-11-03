import { deriveTransactions, type DerivationFile } from './derive';

const IBAN = 'LT100000000000000099';
const header = {
  Type: 'Card Payment',
  Product: 'Current',
  'Started Date': '2026-08-28 19:20:23',
  'Completed Date': '2026-08-29 12:23:37',
  Description: 'Lidl',
  Amount: '-0.29',
  Fee: '0.00',
  Currency: 'EUR',
  State: 'COMPLETED',
  Balance: '11.62',
};

function revolutFile(
  ids: string[],
  overrides: Record<string, string>[] = [],
): DerivationFile {
  return {
    bank: 'revolut',
    accountId: 'A',
    accountIban: IBAN,
    rows: ids.map((rawRowId, i) => ({
      rawRowId,
      rowNumber: i + 1,
      payload: { ...header, ...(overrides[i] ?? {}) },
    })),
  };
}

let counter = 0;
const nextId = () => `t${++counter}`;

describe('deriveTransactions', () => {
  beforeEach(() => {
    counter = 0;
  });

  it('links every normalized row to a transaction and skips raw-only rows', () => {
    const file = revolutFile(['r1', 'r2'], [{}, { State: 'PENDING' }]);

    const { transactions, sources } = deriveTransactions([file], nextId);

    expect(transactions).toHaveLength(1);
    expect(sources).toEqual([
      { transactionId: 't1', rawRowId: 'r1', accountId: 'A' },
    ]);
  });

  it('gives overlapping files one transaction with two sources', () => {
    const first = revolutFile(['r1']);
    const second = revolutFile(['r2']);

    const { transactions, sources } = deriveTransactions([first, second], nextId);

    expect(transactions).toHaveLength(1);
    expect(sources.map((s) => s.rawRowId)).toEqual(['r1', 'r2']);
    expect(new Set(sources.map((s) => s.transactionId)).size).toBe(1);
  });

  it('keeps identical-looking rows of one file as distinct transactions', () => {
    const { transactions } = deriveTransactions([revolutFile(['r1', 'r2'])], nextId);

    expect(transactions).toHaveLength(2);
  });

  it('is deterministic apart from ids', () => {
    const files = [revolutFile(['r1', 'r2'])];
    const strip = (d: ReturnType<typeof deriveTransactions>) =>
      d.transactions.map((t) => t.row);

    expect(strip(deriveTransactions(files))).toEqual(
      strip(deriveTransactions(files)),
    );
  });

  it('derives a multi-account SEB file per account', () => {
    const sebRow = (code: string, iban: string) => ({
      DATA: '2026-08-29',
      VALIUTA: 'EUR',
      SUMA: '1,00',
      'MOKĖJIMO PASKIRTIS': 'x',
      'TRANSAKCIJOS KODAS': code,
      'DEBETAS/KREDITAS': 'D',
      'SĄSKAITOS NR': iban,
    });
    const files: DerivationFile[] = [
      {
        bank: 'seb',
        accountId: 'A',
        accountIban: 'LT1',
        rows: [{ rawRowId: 'r1', rowNumber: 1, payload: sebRow('K1', 'LT1') }],
      },
      {
        bank: 'seb',
        accountId: 'B',
        accountIban: 'LT2',
        rows: [{ rawRowId: 'r2', rowNumber: 2, payload: sebRow('K1', 'LT2') }],
      },
    ];

    const { transactions } = deriveTransactions(files, nextId);

    // Same provider id on two accounts: one transaction each.
    expect(transactions.map((t) => [t.accountId, t.row.dedupKey])).toEqual([
      ['A', 'seb:K1'],
      ['B', 'seb:K1'],
    ]);
  });

  it('reflects a changed normalization without new raw rows', () => {
    const file = revolutFile(['r1'], [{ Description: '  LIDL  ' }]);

    expect(deriveTransactions([file], nextId).transactions[0]?.row.description).toBe(
      'lidl',
    );
  });
});
