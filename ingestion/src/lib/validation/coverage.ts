import {
  computeCoverage,
  hasBalances,
  type CoverageAccount,
  type Segment,
} from 'shared';
import { formatMinorUnits } from '../dedupKey';
import type { ValidationReason } from './types';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A segment's period: its declared bounds when the format states them,
// otherwise its first and last transaction dates.
function periodOf(segment: Segment): {
  from: string | null;
  to: string | null;
} {
  return {
    from: segment.declaredFrom ?? segment.activityFrom,
    to: segment.declaredTo ?? segment.activityTo,
  };
}

// Reasons to reject a file about to be added: a gap on either side of it, or a
// mismatch with the account's opening when it becomes the earliest segment. A
// gap means the stored balance would not be continuous, so the file is not
// stored; each message names the period that has to be imported first.
// Unknown continuity is never a reason; the coverage report shows it.
export function continuityReasons(
  account: CoverageAccount,
  stored: readonly Segment[],
  incoming: Segment,
): ValidationReason[] {
  const coverage = computeCoverage(account, [...stored, incoming]);
  const reasons: ValidationReason[] = [];

  const money = (v: number | null) =>
    v === null
      ? '?'
      : `${formatMinorUnits(v, account.currency)} ${account.currency}`;
  const byId = (id: string) => stored.find((s) => s.fileId === id);
  const mine = periodOf(incoming);

  for (const link of coverage.links) {
    if (link.continuity !== 'gap') continue;
    if (link.toFileId === incoming.fileId) {
      const earlier = byId(link.fromFileId);
      const historyEnd = earlier ? periodOf(earlier).to : null;
      const missing =
        historyEnd && mine.from
          ? ` Import the period ${addDays(historyEnd, 1)} to ${addDays(mine.from, -1)} first.`
          : '';
      const balances =
        earlier && hasBalances(earlier) && hasBalances(incoming)
          ? ` Opening balance ${money(incoming.openingBalanceMinorUnits)} does not match the earlier import's closing balance ${money(earlier.closingBalanceMinorUnits)}.`
          : '';
      reasons.push({
        code: 'gap-before',
        message: `Stored history ends ${historyEnd ?? 'at an unknown date'} and this file starts ${mine.from ?? 'at an unknown date'}.${balances}${missing}`,
      });
    } else if (link.fromFileId === incoming.fileId) {
      const later = byId(link.toFileId);
      const historyStart = later ? periodOf(later).from : null;
      const missing =
        mine.to && historyStart
          ? ` Import the period ${addDays(mine.to, 1)} to ${addDays(historyStart, -1)} first.`
          : '';
      const balances =
        later && hasBalances(later) && hasBalances(incoming)
          ? ` Closing balance ${money(incoming.closingBalanceMinorUnits)} does not match the later import's opening balance ${money(later.openingBalanceMinorUnits)}.`
          : '';
      reasons.push({
        code: 'gap-after',
        message: `This file ends ${mine.to ?? 'at an unknown date'} and stored history starts ${historyStart ?? 'at an unknown date'}.${balances}${missing}`,
      });
    }
  }

  const earliest = coverage.periods[0];
  if (
    earliest?.fileId === incoming.fileId &&
    coverage.connectsToOpening === 'gap'
  ) {
    const opening = `the account's opening balance ${money(account.openingBalanceMinorUnits)} on ${account.openedOn}`;
    reasons.push({
      code: 'gap-opening',
      message:
        incoming.openingBalanceMinorUnits !== null
          ? `This file's opening balance ${money(incoming.openingBalanceMinorUnits)} differs from ${opening}. Import the statements before ${mine.from ?? 'this file'} first.`
          : `This file's declared period starts ${mine.from ?? 'after the account was opened'}, after ${opening}. Import the earlier statements first.`,
    });
  }
  return reasons;
}
