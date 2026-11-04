import type { Coverage } from 'shared';
import type { MemberAccount } from '../memberAccounts';

const BANK_NAMES: Record<string, string> = {
  seb: 'SEB',
  revolut: 'Revolut',
  monobank: 'monobank',
};

export const bankName = (bank: string): string => BANK_NAMES[bank] ?? bank;

// Only the last 4 characters: enough to tell accounts apart, not enough to
// leave a full IBAN sitting in the chat.
export const maskIban = (iban: string): string => `…${iban.slice(-4)}`;

export const accountLabel = (account: MemberAccount): string =>
  `${account.displayName} (${maskIban(account.iban)})`;

export interface AccountSummary {
  account: MemberAccount;
  // null when the account has no history that connects to its opening balance,
  // or when coverage could not be read.
  reconciledUpTo: string | null;
}

export function formatAccountList(summaries: AccountSummary[]): string {
  if (summaries.length === 0) {
    return 'You have no accounts yet. Create one with /newaccount.';
  }
  const lines = summaries.flatMap(({ account, reconciledUpTo }, index) => [
    `${index + 1}. ${account.displayName} · ${bankName(account.bank)} · ${maskIban(account.iban)} · ${account.currency} · ${account.role}`,
    `   ${reconciledUpTo ? `Reconciled up to ${reconciledUpTo}` : 'Not reconciled yet'}`,
  ]);
  return ['Your accounts:', ...lines].join('\n');
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const span = (from: string | null, to: string | null): string =>
  from && to ? (from === to ? from : `${from} to ${to}`) : 'no dates';

export function formatCoverage(
  account: MemberAccount,
  coverage: Coverage,
): string {
  const lines = [`Coverage of ${accountLabel(account)}`];

  if (coverage.reconciledUpTo) {
    lines.push(`Reconciled up to ${coverage.reconciledUpTo}.`);
  } else if (coverage.periods.length === 0) {
    lines.push('Nothing has been imported yet.');
  } else {
    lines.push(
      coverage.connectsToOpening === 'gap'
        ? 'Not reconciled: the first import does not match the account’s opening balance or date.'
        : 'Not reconciled: there is not enough information to connect the history to the opening balance.',
    );
  }

  if (coverage.periods.length > 0) {
    lines.push('', 'Imported periods:');
    for (const period of coverage.periods) {
      lines.push(`• ${span(period.from, period.to)}`);
    }
  }

  const gaps: string[] = [];
  const unknown: string[] = [];
  coverage.links.forEach((link, i) => {
    const before = coverage.periods[i];
    const after = coverage.periods[i + 1];
    if (!before || !after) return;
    if (link.continuity === 'gap') {
      const from = before.to ? addDays(before.to, 1) : null;
      const to = after.from ? addDays(after.from, -1) : null;
      // No missing days: the periods touch but the balances disagree.
      gaps.push(
        from && to && from <= to
          ? `• ${span(from, to)}: no statement covers these days`
          : `• around ${before.to ?? '?'}: the balances do not match between two imports`,
      );
    } else if (link.continuity === 'unknown') {
      unknown.push(
        `• between ${before.to ?? '?'} and ${after.from ?? '?'}: cannot tell whether anything is missing`,
      );
    }
  });
  if (gaps.length > 0) lines.push('', 'Gaps:', ...gaps);
  if (unknown.length > 0) lines.push('', 'Unclear:', ...unknown);

  return lines.join('\n');
}
