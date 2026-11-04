import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { executeStatement, withCaller, type DataApiConfig } from '../dataApi';

// row). Coverage is computed from segments alone (design.md decision 3a).
export interface Segment {
  fileId: string;
  declaredFrom: string | null;
  declaredTo: string | null;
  activityFrom: string | null;
  activityTo: string | null;
  openingBalanceMinorUnits: number | null;
  closingBalanceMinorUnits: number | null;
}

export interface CoverageAccount {
  currency: string;
  openedOn: string;
  openingBalanceMinorUnits: number;
}

export type Continuity = 'continuous' | 'gap' | 'unknown';

export interface CoveragePeriod {
  fileId: string;
  from: string | null;
  to: string | null;
}

export interface CoverageLink {
  fromFileId: string;
  toFileId: string;
  continuity: Continuity;
}

export interface Coverage {
  periods: CoveragePeriod[];
  links: CoverageLink[];
  // Latest date up to which history is continuous from the account's opening;
  // null when not even the first segment connects to the opening.
  reconciledUpTo: string | null;
  // Whether the earliest segment connects to the account's opening.
  connectsToOpening: Continuity;
}

// A segment's period is its declared bounds when the format states them,
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

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function hasBalances(segment: Segment): boolean {
  return (
    segment.openingBalanceMinorUnits !== null &&
    segment.closingBalanceMinorUnits !== null
  );
}

function hasDeclared(segment: Segment): boolean {
  return segment.declaredFrom !== null && segment.declaredTo !== null;
}

function compareSegments(a: Segment, b: Segment): number {
  const pa = periodOf(a);
  const pb = periodOf(b);
  // Segments with no period at all (nothing but excluded rows) sort last.
  if (pa.from === null || pb.from === null) {
    return pa.from === pb.from ? 0 : pa.from === null ? 1 : -1;
  }
  return (
    pa.from.localeCompare(pb.from) || (pa.to ?? '').localeCompare(pb.to ?? '')
  );
}

function linkContinuity(earlier: Segment, later: Segment): Continuity {
  if (hasBalances(earlier) && hasBalances(later)) {
    if (earlier.closingBalanceMinorUnits === later.openingBalanceMinorUnits) {
      return 'continuous';
    }
    // Overlapping statements legitimately start before the earlier one ends;
    // the overlap-agreement rule already proved their shared transactions
    // match, so overlap is continuity too.
    if (
      later.activityFrom !== null &&
      earlier.activityTo !== null &&
      later.activityFrom <= earlier.activityTo
    ) {
      return 'continuous';
    }
    return 'gap';
  }
  if (hasDeclared(earlier) && hasDeclared(later)) {
    // "Touch or overlap": the next period may start the day after.
    return (later.declaredFrom as string) <=
      addDays(earlier.declaredTo as string, 1)
      ? 'continuous'
      : 'gap';
  }
  return 'unknown';
}

function connectsToOpening(
  first: Segment,
  account: CoverageAccount,
): Continuity {
  if (first.openingBalanceMinorUnits !== null) {
    return first.openingBalanceMinorUnits === account.openingBalanceMinorUnits
      ? 'continuous'
      : 'gap';
  }
  if (hasDeclared(first)) {
    return (first.declaredFrom as string) <= account.openedOn
      ? 'continuous'
      : 'gap';
  }
  return 'unknown';
}

export function computeCoverage(
  account: CoverageAccount,
  segments: readonly Segment[],
): Coverage {
  const sorted = [...segments].sort(compareSegments);
  const periods = sorted.map((s) => ({ fileId: s.fileId, ...periodOf(s) }));
  const links: CoverageLink[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const earlier = sorted[i - 1] as Segment;
    const later = sorted[i] as Segment;
    links.push({
      fromFileId: earlier.fileId,
      toFileId: later.fileId,
      continuity: linkContinuity(earlier, later),
    });
  }

  const first = sorted[0];
  const opening: Continuity = first
    ? connectsToOpening(first, account)
    : 'unknown';

  let reconciledUpTo: string | null = null;
  if (first && opening === 'continuous') {
    reconciledUpTo = periodOf(first).to;
    for (let i = 0; i < links.length; i++) {
      if ((links[i] as CoverageLink).continuity !== 'continuous') break;
      const to = periods[i + 1]?.to ?? null;
      if (to !== null && (reconciledUpTo === null || to > reconciledUpTo)) {
        reconciledUpTo = to;
      }
    }
  }

  return { periods, links, reconciledUpTo, connectsToOpening: opening };
}

interface SegmentRow {
  file_id: string;
  declared_from: string | null;
  declared_to: string | null;
  activity_from: string | null;
  activity_to: string | null;
  opening_balance_minor_units: number | null;
  closing_balance_minor_units: number | null;
}

// Reads only `statement_file_accounts`, which is scoped to the account, so a
// member of a non-selected account of a multi-account file sees that file.
export async function loadSegments(
  client: RDSDataClient,
  config: DataApiConfig,
  accountId: string,
  transactionId: string,
): Promise<Segment[]> {
  const { rows } = await executeStatement(
    client,
    config,
    `SELECT file_id, declared_from, declared_to, activity_from, activity_to,
            opening_balance_minor_units, closing_balance_minor_units
       FROM statement_file_accounts WHERE account_id = :accountId`,
    { accountId },
    transactionId,
  );
  return (rows as unknown as SegmentRow[]).map((r) => ({
    fileId: r.file_id,
    declaredFrom: r.declared_from,
    declaredTo: r.declared_to,
    activityFrom: r.activity_from,
    activityTo: r.activity_to,
    openingBalanceMinorUnits: r.opening_balance_minor_units,
    closingBalanceMinorUnits: r.closing_balance_minor_units,
  }));
}

// Runs as `sub`: an account the caller isn't a member of is "not found".
export async function getAccountCoverage(
  client: RDSDataClient,
  config: DataApiConfig,
  sub: string,
  accountId: string,
): Promise<Coverage> {
  return withCaller(client, config, sub, async (transactionId) => {
    const { rows } = await executeStatement(
      client,
      config,
      `SELECT currency, opened_on, opening_balance_minor_units FROM accounts WHERE id = :accountId`,
      { accountId },
      transactionId,
    );
    const account = rows[0] as
      | {
          currency: string;
          opened_on: string;
          opening_balance_minor_units: number;
        }
      | undefined;
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    return computeCoverage(
      {
        currency: account.currency,
        openedOn: account.opened_on,
        openingBalanceMinorUnits: account.opening_balance_minor_units,
      },
      await loadSegments(client, config, accountId, transactionId),
    );
  });
}
