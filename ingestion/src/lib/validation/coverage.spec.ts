import { continuityReasons } from './coverage';
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
describe('continuityReasons', () => {
  const march = balanceSegment('mar', '2026-03-02', '2026-03-30', 1700, 900);

  it('rejects a January file that does not connect to stored March, naming the missing period', () => {
    const jan = balanceSegment('jan', '2026-01-02', '2026-01-30', 1000, 2000);

    const reasons = continuityReasons(account, [march], jan);

    expect(reasons).toEqual([
      expect.objectContaining({
        code: 'gap-after',
        message: expect.stringMatching(
          /ends 2026-01-30 and stored history starts 2026-03-02.*20\.00 EUR.*17\.00 EUR.*2026-01-31 to 2026-03-01/,
        ),
      }),
    ]);
  });

  it('has no reason when the new file connects to history', () => {
    const feb = balanceSegment('feb', '2026-02-03', '2026-02-27', 1000, 1700);

    expect(continuityReasons(account, [march], feb)).toEqual([]);
  });

  it('rejects when the earliest file does not match the account opening, naming it', () => {
    const first = balanceSegment('a', '2026-01-02', '2026-01-30', 500, 900);

    expect(continuityReasons(account, [], first)).toEqual([
      expect.objectContaining({
        code: 'gap-opening',
        message: expect.stringMatching(/10\.00 EUR on 2024-01-01/),
      }),
    ]);
  });

  it('never rejects when continuity is merely unknown', () => {
    const a = bareSegment('a', '2026-01-01', '2026-01-31');
    const b = bareSegment('b', '2026-03-01', '2026-03-31');

    expect(continuityReasons(account, [a], b)).toEqual([]);
  });

  it('rejects a declared-period gap naming the history end and file start', () => {
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

    expect(continuityReasons(account, [jan], mar)).toEqual([
      expect.objectContaining({
        code: 'gap-before',
        message: expect.stringMatching(
          /ends 2026-01-31 and this file starts 2026-03-01.*2026-02-01 to 2026-02-28/,
        ),
      }),
    ]);
  });
});
