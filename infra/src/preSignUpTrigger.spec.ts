import { isAllowlisted, parseAllowlist } from './preSignUpTrigger';

describe('parseAllowlist', () => {
  it('splits, trims, and lowercases a comma-separated list', () => {
    expect(parseAllowlist(' Me@Example.com, wife@example.com ')).toEqual(
      new Set(['me@example.com', 'wife@example.com']),
    );
  });

  it('returns an empty set for undefined input', () => {
    expect(parseAllowlist(undefined)).toEqual(new Set());
  });
});

describe('isAllowlisted', () => {
  const allowlist = parseAllowlist('me@example.com,wife@example.com');

  it('accepts an allowlisted email', () => {
    expect(isAllowlisted('me@example.com', allowlist)).toBe(true);
  });

  it('accepts an allowlisted email regardless of case', () => {
    expect(isAllowlisted('ME@Example.com', allowlist)).toBe(true);
  });

  it('rejects a non-allowlisted email', () => {
    expect(isAllowlisted('stranger@example.com', allowlist)).toBe(false);
  });

  it('rejects an undefined email', () => {
    expect(isAllowlisted(undefined, allowlist)).toBe(false);
  });
});
