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
// `transactions` (i.e. that affect the balance) are present. Each normalizer
// already numbered its rows in that order (`sourceSeq`, see parsers/order.ts),
// which differs per format: monobank lists newest first, Revolut changes the
// balance on completion rather than at `Started Date`.
function chronologicalChainRows(rows: ParsedRow[]): ChainRow[] {
  return rows
    .filter(hasBalance)
    .map((row) => ({ ...row, normalized: row.normalized }))
    .sort((a, b) => a.normalized.sourceSeq - b.normalized.sourceSeq);
}

// Each row's balance must equal the previous row's balance + its amount − its
// fee. SEB has no per-row balance, so it yields no chain rows and passes.
export function checkBalanceChain(parsed: ParsedStatement): BalanceChainResult {
  const reasons: ValidationReason[] = [];
  const balancesByIban = new Map<string, AccountBalances>();

  const byIban = new Map<string, ParsedRow[]>();
  for (const row of parsed.rows) {
    byIban.set(row.iban, [...(byIban.get(row.iban) ?? []), row]);
  }

  for (const [iban, rows] of byIban) {
    const chain = chronologicalChainRows(rows);
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

  reconcileDeclaredBalances(parsed, reasons, balancesByIban);

  return { reasons, balancesByIban };
}

// Formats that state an opening and closing balance per account (Swedbank)
// have no per-row balance to chain. Instead the stated opening plus the
// account's transactions must reach the stated closing, and any stated turnover
// must equal the transactions' debit and credit sums. The stated balances then
// stand in for the chain's, so continuity between files works the same way.
function reconcileDeclaredBalances(
  parsed: ParsedStatement,
  reasons: ValidationReason[],
  balancesByIban: Map<string, AccountBalances>,
): void {
  for (const declared of parsed.declaredBalances ?? []) {
    const own = parsed.rows.flatMap((row) =>
      row.iban === declared.iban && row.normalized ? [row.normalized] : [],
    );
    const currency = own[0]?.currency ?? parsed.rows[0]?.currency ?? '';
    const money = (v: number) => `${formatMinorUnits(v, currency)} ${currency}`;
    const net = own.reduce(
      (sum, t) => sum + t.amountMinorUnits - t.feeMinorUnits,
      0,
    );
    const expectedClosing = declared.openingMinorUnits + net;
    if (expectedClosing !== declared.closingMinorUnits) {
      reasons.push({
        code: 'balance-mismatch',
        message: `Account ${declared.iban}: opening balance ${money(declared.openingMinorUnits)} plus transactions ${money(net)} gives ${money(expectedClosing)}, but the file states a closing balance of ${money(declared.closingMinorUnits)}`,
      });
    }
    if (declared.turnover) {
      const debit = own
        .filter((t) => t.amountMinorUnits < 0)
        .reduce((sum, t) => sum - t.amountMinorUnits, 0);
      const credit = own
        .filter((t) => t.amountMinorUnits > 0)
        .reduce((sum, t) => sum + t.amountMinorUnits, 0);
      for (const [direction, expected, actual] of [
        ['debit', debit, declared.turnover.debitMinorUnits],
        ['credit', credit, declared.turnover.creditMinorUnits],
      ] as const) {
        if (expected !== actual) {
          reasons.push({
            code: 'turnover-mismatch',
            message: `Account ${declared.iban}: ${direction} turnover ${money(actual)} stated by the file differs from the transactions' ${money(expected)}`,
          });
        }
      }
    }
    if (!balancesByIban.has(declared.iban)) {
      balancesByIban.set(declared.iban, {
        openingBalanceMinorUnits: declared.openingMinorUnits,
        closingBalanceMinorUnits: declared.closingMinorUnits,
      });
    }
  }
}
