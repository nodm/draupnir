const { rebuildAccount, backfillAccountBalances } = vi.hoisted(() => ({
  rebuildAccount: vi.fn(),
  backfillAccountBalances: vi.fn(),
}));
vi.mock('./lib/rebuildAccount', () => ({ rebuildAccount }));
vi.mock('./lib/backfillAccountBalances', () => ({ backfillAccountBalances }));
vi.mock('shared', () => ({ loadDataApiConfigFromEnv: () => ({}) }));
vi.mock('@aws-sdk/client-rds-data', () => ({ RDSDataClient: class {} }));

import { handler } from './rebuildAccount';

beforeEach(() => {
  rebuildAccount.mockReset().mockResolvedValue({});
  backfillAccountBalances.mockReset().mockResolvedValue({});
});

describe('rebuild-account handler', () => {
  const base = { sub: 'u', accountId: 'a' };

  it('rebuilds by default and when asked to', async () => {
    await handler(base);
    await handler({ ...base, mode: 'rebuild' });

    expect(rebuildAccount).toHaveBeenCalledTimes(2);
    expect(backfillAccountBalances).not.toHaveBeenCalled();
  });

  it('backfills without rebuilding when asked to', async () => {
    await handler({ ...base, mode: 'backfill' });

    expect(backfillAccountBalances).toHaveBeenCalledTimes(1);
    expect(rebuildAccount).not.toHaveBeenCalled();
  });

  it.each(['backfil', 'BACKFILL', '', null])(
    'rejects the mode %j instead of falling through to the destructive rebuild',
    async (mode) => {
      await expect(handler({ ...base, mode } as never)).rejects.toThrow(
        /Unknown mode/,
      );
      expect(rebuildAccount).not.toHaveBeenCalled();
      expect(backfillAccountBalances).not.toHaveBeenCalled();
    },
  );
});
