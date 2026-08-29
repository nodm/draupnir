import { extractWhoamiClaims } from './whoami';

describe('extractWhoamiClaims', () => {
  it('returns the sub and email claims', () => {
    expect(
      extractWhoamiClaims({ sub: 'user-123', email: 'me@example.com' }),
    ).toEqual({
      sub: 'user-123',
      email: 'me@example.com',
    });
  });

  it('throws when sub is missing', () => {
    expect(() => extractWhoamiClaims({ email: 'me@example.com' })).toThrow();
  });

  it('throws when email is missing', () => {
    expect(() => extractWhoamiClaims({ sub: 'user-123' })).toThrow();
  });
});
