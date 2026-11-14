import type { Coverage } from 'shared';
import type { MemberAccount } from '../memberAccounts';
import { htmlToPlainText } from '../telegram';
import {
  bold,
  code,
  escapeHtml,
  formatAccountList,
  formatCoverage,
  maskIban,
} from './format';

const account: MemberAccount = {
  id: 'a',
  bank: 'seb',
  iban: 'LT121000011101001000',
  currency: 'EUR',
  displayName: 'SEB main',
  role: 'owner',
  balanceMinorUnits: 106950,
  balanceAsOf: '2026-08-29',
  balanceReconciled: true,
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

describe('HTML helpers', () => {
  it('escapes & < > and nothing else', () => {
    expect(escapeHtml('a<b>&"c\'_*.-')).toBe('a&lt;b&gt;&amp;"c\'_*.-');
  });

  it('escapes the text they wrap', () => {
    expect(bold('a<b')).toBe('<b>a&lt;b</b>');
    expect(code('…1&2')).toBe('<code>…1&amp;2</code>');
  });
});

describe('formatAccountList', () => {
  it('shows one block per account and never prints a full IBAN', () => {
    const text = formatAccountList([
      { account, reconciledUpTo: '2026-03-31' },
      {
        account: { ...account, displayName: 'Other', role: 'viewer' },
        reconciledUpTo: null,
      },
    ]);
    expect(text).toBe(
      [
        '<b>Your accounts</b>',
        [
          '<b>1. SEB main</b> (owner)',
          'SEB · <code>…1000</code> · EUR',
          'Balance <code>1069.50 EUR</code> as of <code>2026-08-29</code>',
          'Reconciled up to <code>2026-03-31</code>',
        ].join('\n'),
        [
          '<b>2. Other</b> (viewer)',
          'SEB · <code>…1000</code> · EUR',
          'Balance <code>1069.50 EUR</code> as of <code>2026-08-29</code>',
          'Not reconciled yet',
        ].join('\n'),
      ].join('\n\n'),
    );
    expect(text).not.toContain('LT12');
  });

  it('formats balance by currency, sign and reconciled flag', () => {
    const text = formatAccountList([
      {
        account: { ...account, currency: 'JPY', balanceMinorUnits: 1500 },
        reconciledUpTo: null,
      },
      {
        account: {
          ...account,
          balanceMinorUnits: -2000,
          balanceReconciled: false,
        },
        reconciledUpTo: null,
      },
    ]);
    expect(text).toContain('Balance <code>1500 JPY</code> as of');
    expect(text).toContain(
      'Balance <code>-20.00 EUR</code> as of <code>2026-08-29</code> (not reconciled)',
    );
  });

  it('shows markup characters in a name literally', () => {
    const text = formatAccountList([
      {
        account: { ...account, displayName: 'Joint <b>& Savings' },
        reconciledUpTo: null,
      },
    ]);
    expect(text).toContain('<b>1. Joint &lt;b&gt;&amp; Savings</b>');
    expect(htmlToPlainText(text)).toContain('1. Joint <b>& Savings');
    expect(text.match(/<b>/g)).toHaveLength(2); // the heading and the name
  });

  it('keeps the plain message when there are no accounts', () => {
    expect(formatAccountList([])).toBe(
      'You have no accounts yet. Create one with /newaccount.',
    );
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
    expect(text).toContain('<b>Gaps</b>');
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
    expect(text).toContain('<b>Unclear</b>');
    expect(text).not.toContain('Gaps');
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
    expect(text).toContain('• <code>2026-05-05</code>');
    expect(text).not.toContain('2026-05-05 to 2026-05-05');
  });

  it('starts with the account heading and the reconciliation status', () => {
    const text = formatCoverage(
      { ...account, displayName: 'A<B & C' },
      coverage({
        periods: [periods[0] as never],
        reconciledUpTo: '2026-01-31',
      }),
    );
    expect(text.split('\n').slice(0, 2)).toEqual([
      'Coverage of <b>A&lt;B &amp; C</b> (<code>…1000</code>)',
      'Reconciled up to <code>2026-01-31</code>.',
    ]);
  });

  it('titles the periods and puts a gap under its own title with dates in code', () => {
    const text = formatCoverage(
      account,
      coverage({
        periods: [
          { fileId: 'f1', from: '2026-01-01', to: '2026-01-31' },
          { fileId: 'f3', from: '2026-03-01', to: '2026-03-31' },
        ],
        links: [{ fromFileId: 'f1', toFileId: 'f3', continuity: 'gap' }],
        reconciledUpTo: '2026-01-31',
      }),
    );
    expect(text).toContain('<b>Imported periods</b>');
    expect(text).toContain('• <code>2026-01-01 to 2026-01-31</code>');
    expect(text).toMatch(
      /<b>Gaps<\/b>\n• <code>2026-02-01 to 2026-02-28<\/code>: no statement covers/,
    );
  });

  it('has no Gaps or Unclear section when the periods connect', () => {
    const text = formatCoverage(
      account,
      coverage({
        periods,
        links: [{ fromFileId: 'f1', toFileId: 'f2', continuity: 'continuous' }],
        reconciledUpTo: '2026-02-28',
      }),
    );
    expect(text).not.toContain('Gaps');
    expect(text).not.toContain('Unclear');
  });

  it('has no period section when nothing was imported', () => {
    const text = formatCoverage(account, coverage({}));
    expect(text).toContain('Nothing has been imported yet.');
    expect(text).not.toContain('Imported periods');
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
    expect(htmlToPlainText(text).length).toBeLessThan(LIMIT);
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
    expect(htmlToPlainText(text).length).toBeLessThan(LIMIT);
    expect(text).toContain('…and 170 earlier not shown');
    expect(text).toMatch(/<b>Gaps<\/b>[\s\S]*…and \d+ more not shown/);
    expect(text).toMatch(/<b>Unclear<\/b>[\s\S]*…and \d+ more not shown/);
  });
});
