import { uploadRetentionDays } from '../lib/uploadRetention';

describe('uploadRetentionDays', () => {
  it('defaults to 30 days when the key is not set', () => {
    expect(uploadRetentionDays(undefined)).toBe(30);
    expect(uploadRetentionDays('')).toBe(30);
  });

  it('accepts a whole number of days longer than the DLQ retention', () => {
    expect(uploadRetentionDays('60')).toBe(60);
    expect(uploadRetentionDays(' 15 ')).toBe(15);
  });

  it.each(['14', '7', '0', '-1', 'abc', '30.5'])(
    'refuses %s, naming the config key and the floor',
    (value) => {
      expect(() => uploadRetentionDays(value)).toThrow(
        /draupnir-infra:uploadRetentionDays.*greater than 14/,
      );
    },
  );
});
