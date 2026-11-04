import type { Coverage } from 'shared';
import type { MemberAccount } from '../memberAccounts';
import { formatAccountList, formatCoverage, maskIban } from './format';

const account: MemberAccount = {
  id: 'a',
  bank: 'seb',
  iban: 'LT121000011101001000',
  currency: 'EUR',
  displayName: 'SEB main',
  role: 'owner',
};

const coverage = (over: Partial<Coverage>): Coverage => ({
  periods: [],
  links: [],
  reconciledUpTo: null,
  connectsToOpening: 'unknown',
  ...over,
});

describe('maskIban', () => {
  it('keeps only the last four characters', () => {
    expect(maskIban('LT121000011101001000')).toBe('…1000');
  });
});

describe('formatAccountList', () => {
  it('numbers the accounts and never prints a full IBAN', () => {
    const text = formatAccountList([
      { account, reconciledUpTo: '2026-03-31' },
      {
        account: { ...account, displayName: 'Other', role: 'viewer' },
        reconciledUpTo: null,
      },
    ]);
    expect(text).toContain('1. SEB main · SEB · …1000 · EUR · owner');
    expect(text).toContain('2. Other');
    expect(text).not.toContain('LT12');
  });
});

describe('formatCoverage', () => {
  const periods = [
    { fileId: 'f1', from: '2026-01-01', to: '2026-01-31' },
    { fileId: 'f2', from: '2026-02-01', to: '2026-02-28' },
  ];

  it('reports a balance mismatch when the periods touch but do not connect', () => {
    const text = formatCoverage(
      account,
      coverage({
        periods,
        links: [{ fromFileId: 'f1', toFileId: 'f2', continuity: 'gap' }],
        reconciledUpTo: '2026-01-31',
      }),
    );
    expect(text).toContain('Gaps:');
    expect(text).toContain('balances do not match');
    expect(text).not.toContain('no statement covers');
  });

  it('flags unclear continuity without calling it a gap', () => {
    const text = formatCoverage(
      account,
      coverage({
        periods,
        links: [{ fromFileId: 'f1', toFileId: 'f2', continuity: 'unknown' }],
      }),
    );
    expect(text).toContain('Unclear:');
    expect(text).not.toContain('Gaps:');
  });

  it('explains why history is not reconciled when it misses the opening', () => {
    expect(
      formatCoverage(
        account,
        coverage({ periods: [periods[0] as never], connectsToOpening: 'gap' }),
      ),
    ).toContain('does not match the account’s opening balance');
  });

  it('shows a period without dates and a single-day period', () => {
    const text = formatCoverage(
      account,
      coverage({
        periods: [
          { fileId: 'f', from: null, to: null },
          { fileId: 'g', from: '2026-05-05', to: '2026-05-05' },
        ],
      }),
    );
    expect(text).toContain('• no dates');
    expect(text).toContain('• 2026-05-05');
    expect(text).not.toContain('2026-05-05 to 2026-05-05');
  });
});

describe('Telegram’s 4096-character limit', () => {
  const LIMIT = 4096;

  it('caps a long account list and says how many were left out', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      account: { ...account, displayName: `${i}`.padEnd(60, 'x') },
      reconciledUpTo: '2026-03-31',
    }));
    const text = formatAccountList(many);
    expect(text.length).toBeLessThan(LIMIT);
    expect(text).toContain('…and 40 more not shown');
  });

  it('caps periods, gaps and unclear links of a long history', () => {
    const periods = Array.from({ length: 200 }, (_, i) => ({
      fileId: `f${i}`,
      from: '2020-01-01',
      to: '2020-01-02',
    }));
    // alternate gap / unknown so both lists overflow
    const links = periods.slice(1).map((_, i) => ({
      fromFileId: `f${i}`,
      toFileId: `f${i + 1}`,
      continuity: i % 2 === 0 ? ('gap' as const) : ('unknown' as const),
    }));
    const text = formatCoverage(account, coverage({ periods, links }));
    expect(text.length).toBeLessThan(LIMIT);
    expect(text).toContain('…and 170 earlier not shown');
    expect(text).toMatch(/Gaps:[\s\S]*…and \d+ more not shown/);
    expect(text).toMatch(/Unclear:[\s\S]*…and \d+ more not shown/);
  });
});
