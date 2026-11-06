import { z } from 'zod';
import {
  computeCoverage,
  segmentFromRow,
  type Continuity,
  type SegmentRow,
} from '../accounts/coverage';
import { memberPredicate } from '../membership';
import { defineDataTool } from './dataTool';

export interface AccountCoverageResult {
  periods: { from: string | null; to: string | null }[];
  // Where consecutive periods don't connect (`from` is the earlier period's
  // end, `to` the later period's start).
  gaps: { from: string | null; to: string | null }[];
  reconciledUpTo: string | null;
  connectsToOpening: Continuity;
}

const EMPTY: AccountCoverageResult = {
  periods: [],
  gaps: [],
  reconciledUpTo: null,
  connectsToOpening: 'unknown',
};

export const getAccountCoverageTool = defineDataTool({
  name: 'get_account_coverage',
  description:
    'Which periods of an account have imported statements, the gaps between them, and the date up to which history is reconciled. Empty for an account the caller cannot see.',
  input: z.strictObject({ accountId: z.string().min(1) }),
  async handler(q, input): Promise<AccountCoverageResult> {
    const { rows } = await q.query(
      `SELECT a.currency, a.opened_on, a.opening_balance_minor_units
         FROM accounts a
        WHERE a.id = :accountId AND ${memberPredicate('a', 'id')}`,
      { accountId: input.accountId, sub: q.sub },
    );
    const account = rows[0] as
      | {
          currency: string;
          opened_on: string;
          opening_balance_minor_units: number;
        }
      | undefined;
    if (!account) return EMPTY;

    const { rows: segmentRows } = await q.query(
      `SELECT file_id, declared_from, declared_to, activity_from, activity_to,
              opening_balance_minor_units, closing_balance_minor_units
         FROM statement_file_accounts WHERE account_id = :accountId`,
      { accountId: input.accountId },
    );
    const coverage = computeCoverage(
      {
        currency: account.currency,
        openedOn: account.opened_on,
        openingBalanceMinorUnits: account.opening_balance_minor_units,
      },
      (segmentRows as unknown as SegmentRow[]).map(segmentFromRow),
    );
    return {
      periods: coverage.periods.map(({ from, to }) => ({ from, to })),
      gaps: coverage.links.flatMap((link, i) =>
        link.continuity === 'gap'
          ? [
              {
                from: coverage.periods[i]?.to ?? null,
                to: coverage.periods[i + 1]?.from ?? null,
              },
            ]
          : [],
      ),
      reconciledUpTo: coverage.reconciledUpTo,
      connectsToOpening: coverage.connectsToOpening,
    };
  },
});
