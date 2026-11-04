import { continuityWarnings } from './coverage';
import type { CoverageAccount, Segment } from 'shared';

const account: CoverageAccount = {
  currency: 'EUR',
  openedOn: '2024-01-01',
  openingBalanceMinorUnits: 1000,
};

function balanceSegment(
  fileId: string,
  from: string,
  to: string,
  opening: number,
  closing: number,
): Segment {
  return {
    fileId,
    declaredFrom: null,
    declaredTo: null,
    activityFrom: from,
    activityTo: to,
    openingBalanceMinorUnits: opening,
    closingBalanceMinorUnits: closing,
  };
}

function declaredSegment(
  fileId: string,
  declaredFrom: string,
  declaredTo: string,
  activityFrom: string,
  activityTo: string,
): Segment {
  return {
    fileId,
    declaredFrom,
    declaredTo,
    activityFrom,
    activityTo,
    openingBalanceMinorUnits: null,
    closingBalanceMinorUnits: null,
  };
}

const bareSegment = (fileId: string, from: string, to: string): Segment => ({
  fileId,
  declaredFrom: null,
  declaredTo: null,
  activityFrom: from,
  activityTo: to,
  openingBalanceMinorUnits: null,
  closingBalanceMinorUnits: null,
});
describe('continuityWarnings', () => {
  const march = balanceSegment('mar', '2026-03-02', '2026-03-30', 1700, 900);

  it('warns about a January file that does not connect to stored March', () => {
    const jan = balanceSegment('jan', '2026-01-02', '2026-01-30', 1000, 2000);

    const warnings = continuityWarnings(account, [march], jan);

    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'gap-after',
        message: expect.stringMatching(/20\.00 EUR.*17\.00 EUR/),
      }),
    ]);
  });

  it('has no warning when the new file connects to history', () => {
    const feb = balanceSegment('feb', '2026-02-03', '2026-02-27', 1000, 1700);

    expect(continuityWarnings(account, [march], feb)).toEqual([]);
  });

  it('warns when the earliest file does not match the account opening', () => {
    const first = balanceSegment('a', '2026-01-02', '2026-01-30', 500, 900);

    expect(continuityWarnings(account, [], first)).toEqual([
      expect.objectContaining({ code: 'gap-opening' }),
    ]);
  });

  it('never warns when continuity is merely unknown', () => {
    const a = bareSegment('a', '2026-01-01', '2026-01-31');
    const b = bareSegment('b', '2026-03-01', '2026-03-31');

    expect(continuityWarnings(account, [a], b)).toEqual([]);
  });

  it('warns about a declared-period gap', () => {
    const jan = declaredSegment(
      'jan',
      '2024-01-01',
      '2026-01-31',
      '2026-01-05',
      '2026-01-27',
    );
    const mar = declaredSegment(
      'mar',
      '2026-03-01',
      '2026-03-31',
      '2026-03-02',
      '2026-03-30',
    );

    expect(continuityWarnings(account, [jan], mar)).toEqual([
      expect.objectContaining({ code: 'gap-before' }),
    ]);
  });
});
