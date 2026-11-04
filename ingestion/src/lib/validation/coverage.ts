import {
  computeCoverage,
  hasBalances,
  type CoverageAccount,
  type Segment,
} from 'shared';
import { formatMinorUnits } from '../dedupKey';
import type { ValidationReason } from './types';

// Warnings for a file about to be added: gaps on either side of it, and a
// mismatch with the account's opening when it becomes the earliest segment.
// Unknown continuity is reported by the coverage report, never as a warning.
export function continuityWarnings(
  account: CoverageAccount,
  stored: readonly Segment[],
  incoming: Segment,
): ValidationReason[] {
  const coverage = computeCoverage(account, [...stored, incoming]);
  const warnings: ValidationReason[] = [];

  const money = (v: number | null) =>
    v === null
      ? '?'
      : `${formatMinorUnits(v, account.currency)} ${account.currency}`;
  const byId = (id: string) => stored.find((s) => s.fileId === id);

  for (const link of coverage.links) {
    if (link.continuity !== 'gap') continue;
    if (link.toFileId === incoming.fileId) {
      const earlier = byId(link.fromFileId);
      warnings.push({
        code: 'gap-before',
        message:
          earlier && hasBalances(earlier) && hasBalances(incoming)
            ? `Opening balance ${money(incoming.openingBalanceMinorUnits)} does not match the earlier import's closing balance ${money(earlier.closingBalanceMinorUnits)}`
            : `The declared period starts after the earlier import's period ends, leaving days uncovered`,
      });
    } else if (link.fromFileId === incoming.fileId) {
      const later = byId(link.toFileId);
      warnings.push({
        code: 'gap-after',
        message:
          later && hasBalances(later) && hasBalances(incoming)
            ? `Closing balance ${money(incoming.closingBalanceMinorUnits)} does not match the later import's opening balance ${money(later.openingBalanceMinorUnits)}`
            : `The declared period ends before the later import's period starts, leaving days uncovered`,
      });
    }
  }

  const earliest = coverage.periods[0];
  if (
    earliest?.fileId === incoming.fileId &&
    coverage.connectsToOpening === 'gap'
  ) {
    warnings.push({
      code: 'gap-opening',
      message:
        incoming.openingBalanceMinorUnits !== null
          ? `Opening balance ${formatMinorUnits(incoming.openingBalanceMinorUnits, account.currency)} ${account.currency} differs from the account's opening balance ${formatMinorUnits(account.openingBalanceMinorUnits, account.currency)} ${account.currency}`
          : `Declared period starts after the account was opened on ${account.openedOn}`,
    });
  }
  return warnings;
}
