// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import {
  applyMigrationsForTest,
  createPgliteDataApiClient,
  type DataApiConfig,
} from 'shared';
import {
  computeCoverage,
  continuityWarnings,
  getAccountCoverage,
  type CoverageAccount,
  type Segment,
} from './coverage';

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

describe('computeCoverage — balance formats', () => {
  const jan = balanceSegment('jan', '2026-01-02', '2026-01-30', 1000, 2000);
  const feb = balanceSegment('feb', '2026-02-03', '2026-02-27', 2000, 1500);

  it('links segments whose closing and opening balances match, despite quiet days', () => {
    const coverage = computeCoverage(account, [feb, jan]);

    expect(coverage.links).toEqual([
      { fromFileId: 'jan', toFileId: 'feb', continuity: 'continuous' },
    ]);
    expect(coverage.reconciledUpTo).toBe('2026-02-27');
  });

  it('reports a gap when balances differ and stops "reconciled up to" before it', () => {
    const mar = balanceSegment('mar', '2026-03-02', '2026-03-30', 1700, 900);

    const coverage = computeCoverage(account, [jan, mar]);

    expect(coverage.links[0]?.continuity).toBe('gap');
    expect(coverage.reconciledUpTo).toBe('2026-01-30');
  });

  it('treats overlapping statements as continuous', () => {
    const overlap = balanceSegment(
      'ov',
      '2026-01-20',
      '2026-02-10',
      1800,
      1400,
    );

    expect(computeCoverage(account, [jan, overlap]).links[0]?.continuity).toBe(
      'continuous',
    );
  });

  it('reconciles nothing when the first segment does not match the account opening', () => {
    const late = balanceSegment('late', '2026-01-02', '2026-01-30', 999, 2000);

    const coverage = computeCoverage(account, [late]);

    expect(coverage.connectsToOpening).toBe('gap');
    expect(coverage.reconciledUpTo).toBeNull();
  });
});

describe('computeCoverage — declared periods', () => {
  it('does not report quiet days as a gap', () => {
    const jan = declaredSegment(
      'jan',
      '2026-01-01',
      '2026-01-31',
      '2026-01-05',
      '2026-01-27',
    );
    const feb = declaredSegment(
      'feb',
      '2026-02-01',
      '2026-02-28',
      '2026-02-02',
      '2026-02-20',
    );

    const coverage = computeCoverage(account, [jan, feb]);

    expect(coverage.links[0]?.continuity).toBe('continuous');
    expect(coverage.periods[0]).toMatchObject({
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });

  it('reports a gap when declared periods leave days uncovered', () => {
    const jan = declaredSegment(
      'jan',
      '2026-01-01',
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

    expect(computeCoverage(account, [jan, mar]).links[0]?.continuity).toBe(
      'gap',
    );
  });

  it('connects to the opening when the declared start is on or before opened_on', () => {
    const early = declaredSegment(
      'a',
      '2023-12-15',
      '2024-01-31',
      '2024-01-02',
      '2024-01-20',
    );

    expect(computeCoverage(account, [early]).connectsToOpening).toBe(
      'continuous',
    );
  });

  it('flags a first period starting after opened_on', () => {
    const late = declaredSegment(
      'a',
      '2024-02-01',
      '2024-02-28',
      '2024-02-02',
      '2024-02-20',
    );

    expect(computeCoverage(account, [late]).connectsToOpening).toBe('gap');
  });
});

describe('computeCoverage — unknown', () => {
  it('reports unknown, not a gap, when neither balances nor declared periods exist', () => {
    const a = bareSegment('a', '2026-01-01', '2026-01-31');
    const b = bareSegment('b', '2026-03-01', '2026-03-31');

    const coverage = computeCoverage(account, [a, b]);

    expect(coverage.links[0]?.continuity).toBe('unknown');
    expect(coverage.connectsToOpening).toBe('unknown');
    expect(coverage.reconciledUpTo).toBeNull();
  });

  it('is empty for an account with no files', () => {
    expect(computeCoverage(account, [])).toEqual({
      periods: [],
      links: [],
      reconciledUpTo: null,
      connectsToOpening: 'unknown',
    });
  });
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

describe('getAccountCoverage (database)', () => {
  const config: DataApiConfig = {
    resourceArn: 'a',
    secretArn: 'a',
    database: 'd',
  };
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsForTest(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it('reports periods and gaps from statement_file_accounts, including a non-selected account', async () => {
    await db.exec(`
      INSERT INTO accounts (id, bank, iban, currency, display_name, opened_on, opening_balance_minor_units) VALUES
        ('A', 'seb', 'LT000000000000000001', 'EUR', 'A', '2026-01-01', 0),
        ('B', 'seb', 'LT000000000000000002', 'EUR', 'B', '2026-01-01', 0);
      INSERT INTO statement_files (id, upload_account_id, uploaded_by, bank, format_version, sha256, s3_key, status) VALUES
        ('f1', 'A', 'u', 'seb', 'seb-v1', 's1', 'k1', 'approved'),
        ('f2', 'A', 'u', 'seb', 'seb-v1', 's2', 'k2', 'approved');
      INSERT INTO statement_file_accounts (file_id, account_id, declared_from, declared_to, activity_from, activity_to) VALUES
        ('f1', 'A', '2026-01-01', '2026-01-31', '2026-01-05', '2026-01-27'),
        ('f1', 'B', '2026-01-01', '2026-01-31', '2026-01-06', '2026-01-20'),
        ('f2', 'A', '2026-03-01', '2026-03-31', '2026-03-02', '2026-03-30');
    `);
    const { client } = createPgliteDataApiClient(db);

    const a = await getAccountCoverage(client, config, 'A');
    const b = await getAccountCoverage(client, config, 'B');

    expect(a.periods.map((p) => [p.fileId, p.from, p.to])).toEqual([
      ['f1', '2026-01-01', '2026-01-31'],
      ['f2', '2026-03-01', '2026-03-31'],
    ]);
    expect(a.links[0]?.continuity).toBe('gap');
    expect(a.reconciledUpTo).toBe('2026-01-31');
    // B only appears in f1, which was uploaded with A selected.
    expect(b.periods.map((p) => p.fileId)).toEqual(['f1']);
    expect(b.reconciledUpTo).toBe('2026-01-31');
  });
});
