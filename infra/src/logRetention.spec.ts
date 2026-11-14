import { logRetentionDays } from '../lib/logRetention';

describe('logRetentionDays', () => {
  it('defaults to 30 days when the key is not set', () => {
    expect(logRetentionDays(undefined)).toBe(30);
    expect(logRetentionDays('')).toBe(30);
  });

  it('accepts a period CloudWatch Logs allows', () => {
    expect(logRetentionDays('14')).toBe(14);
    expect(logRetentionDays(' 365 ')).toBe(365);
  });

  it.each(['45', '0', 'abc', '-30', '30.5'])(
    'refuses %s, naming the config key and the accepted values',
    (value) => {
      expect(() => logRetentionDays(value)).toThrow(
        /draupnir-infra:logRetentionDays.*1, 3, 5, 7, 14, 30/,
      );
    },
  );
});
