import { z } from 'zod';
import {
  computeCoverage,
  segmentFromRow,
  type Segment,
  type SegmentRow,
} from '../accounts/coverage';
import { memberPredicate, type MemberRole } from '../membership';
import { defineDataTool } from './dataTool';

export interface AccountSummary {
  id: string;
  displayName: string;
  bank: string;
  currency: string;
  ibanMasked: string;
  role: MemberRole;
  reconciledUpTo: string | null;
}

interface AccountRow {
  id: string;
  display_name: string;
  bank: string;
  currency: string;
  iban: string;
  opened_on: string;
  opening_balance_minor_units: number;
  role: MemberRole;
}

export const maskIban = (iban: string): string => `****${iban.slice(-4)}`;

export const listAccounts = defineDataTool({
  name: 'list_accounts',
  description:
    "List the caller's accounts (id, name, bank, currency, masked IBAN, the caller's role, and the date up to which history is reconciled).",
  input: z.strictObject({}),
  async handler(q): Promise<AccountSummary[]> {
    const { rows } = await q.query(
      `SELECT a.id, a.display_name, a.bank, a.currency, a.iban, a.opened_on,
              a.opening_balance_minor_units, m.role
         FROM accounts a
         JOIN account_members m ON m.account_id = a.id AND m.user_id = :sub
        ORDER BY a.display_name, a.id`,
      { sub: q.sub },
    );
    const { rows: segmentRows } = await q.query(
      `SELECT f.account_id, f.file_id, f.declared_from, f.declared_to,
              f.activity_from, f.activity_to,
              f.opening_balance_minor_units, f.closing_balance_minor_units
         FROM statement_file_accounts f
        WHERE ${memberPredicate('f', 'account_id')}`,
      { sub: q.sub },
    );
    const segments = new Map<string, Segment[]>();
    for (const r of segmentRows as unknown as (SegmentRow & {
      account_id: string;
    })[]) {
      const list = segments.get(r.account_id) ?? [];
      list.push(segmentFromRow(r));
      segments.set(r.account_id, list);
    }
    return (rows as unknown as AccountRow[]).map((a) => ({
      id: a.id,
      displayName: a.display_name,
      bank: a.bank,
      currency: a.currency,
      ibanMasked: maskIban(a.iban),
      role: a.role,
      reconciledUpTo: computeCoverage(
        {
          currency: a.currency,
          openedOn: a.opened_on,
          openingBalanceMinorUnits: a.opening_balance_minor_units,
        },
        segments.get(a.id) ?? [],
      ).reconciledUpTo,
    }));
  },
});
