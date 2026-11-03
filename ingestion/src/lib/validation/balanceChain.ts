import type { Bank } from 'shared';
import { formatMinorUnits } from '../dedupKey';
import type {
  NormalizedRow,
  ParsedRow,
  ParsedStatement,
} from '../parsers/types';
import type { ValidationReason } from './types';

export interface AccountBalances {
  openingBalanceMinorUnits: number;
  closingBalanceMinorUnits: number;
}

export interface BalanceChainResult {
  reasons: ValidationReason[];
  // Per account IBAN, only for formats with a per-row balance.
  balancesByIban: Map<string, AccountBalances>;
}

interface ChainRow {
  rowNumber: number;
  normalized: NormalizedRow & { balanceAfterMinorUnits: number };
}

function hasBalance(row: ParsedRow): row is ParsedRow & {
  normalized: NormalizedRow & { balanceAfterMinorUnits: number };
} {
  return row.normalized?.balanceAfterMinorUnits !== undefined;
}

// Rows in the order the balance actually changed. Only rows that entered
// `transactions` (i.e. that affect the balance) are present; the bank's own
// order differs per format.
function chronologicalChainRows(bank: Bank, rows: ParsedRow[]): ChainRow[] {
  const chain = rows
    .filter(hasBalance)
    .map((row) => ({ ...row, normalized: row.normalized }));

  if (bank === 'monobank') {
    // newest first in the export
    return chain.reverse();
  }
  if (bank === 'revolut') {
    // The balance changes on completion, while `Started Date` is only the
    // posting/dedup basis. Array.sort is stable, so ties keep file order.
    return [...chain].sort((a, b) =>
      (a.payload['Completed Date'] as string).localeCompare(
        b.payload['Completed Date'] as string,
      ),
    );
  }
  return chain;
}

// Each row's balance must equal the previous row's balance + its amount − its
// fee. SEB has no per-row balance, so it yields no chain rows and passes.
export function checkBalanceChain(
  bank: Bank,
  parsed: ParsedStatement,
): BalanceChainResult {
  const reasons: ValidationReason[] = [];
  const balancesByIban = new Map<string, AccountBalances>();

  const byIban = new Map<string, ParsedRow[]>();
  for (const row of parsed.rows) {
    byIban.set(row.iban, [...(byIban.get(row.iban) ?? []), row]);
  }

  for (const [iban, rows] of byIban) {
    const chain = chronologicalChainRows(bank, rows);
    const first = chain[0];
    const last = chain[chain.length - 1];
    if (!first || !last) continue;

    for (let i = 1; i < chain.length; i++) {
      const previous = (chain[i - 1] as ChainRow).normalized;
      const { rowNumber, normalized } = chain[i] as ChainRow;
      const expected =
        previous.balanceAfterMinorUnits +
        normalized.amountMinorUnits -
        normalized.feeMinorUnits;
      if (expected !== normalized.balanceAfterMinorUnits) {
        const currency = normalized.currency;
        reasons.push({
          code: 'balance-chain-broken',
          row: rowNumber,
          message: `Row ${rowNumber}: balance ${formatMinorUnits(normalized.balanceAfterMinorUnits, currency)} ${currency} does not follow the previous row (expected ${formatMinorUnits(expected, currency)} ${currency})`,
        });
      }
    }

    balancesByIban.set(iban, {
      openingBalanceMinorUnits:
        first.normalized.balanceAfterMinorUnits -
        first.normalized.amountMinorUnits +
        first.normalized.feeMinorUnits,
      closingBalanceMinorUnits: last.normalized.balanceAfterMinorUnits,
    });
  }

  return { reasons, balancesByIban };
}
