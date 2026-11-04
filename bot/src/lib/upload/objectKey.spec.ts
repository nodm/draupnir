import {
  isPreconditionFailed,
  statementObjectKey,
  uuidFromSeed,
} from './objectKey';

describe('uuidFromSeed', () => {
  it('is stable for a seed and different across seeds', () => {
    expect(uuidFromSeed('a')).toBe(uuidFromSeed('a'));
    expect(uuidFromSeed('a')).not.toBe(uuidFromSeed('b'));
  });

  it('has the shape of a version-5 UUID', () => {
    expect(uuidFromSeed('anything')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('statementObjectKey', () => {
  it('lives under the caller’s prefix and account', () => {
    expect(statementObjectKey('sub-1', 'acc-9', 'seed')).toMatch(
      /^uploads\/sub-1\/acc-9\/[0-9a-f-]{36}\.csv$/,
    );
  });
});

describe('isPreconditionFailed', () => {
  it('recognises S3’s 412 by name or status', () => {
    expect(isPreconditionFailed({ name: 'PreconditionFailed' })).toBe(true);
    expect(isPreconditionFailed({ $metadata: { httpStatusCode: 412 } })).toBe(
      true,
    );
  });

  it('does not treat other errors as already-written', () => {
    expect(isPreconditionFailed(new Error('timeout'))).toBe(false);
    expect(isPreconditionFailed({ $metadata: { httpStatusCode: 500 } })).toBe(
      false,
    );
    expect(isPreconditionFailed(undefined)).toBe(false);
  });
});
