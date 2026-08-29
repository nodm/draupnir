import type { PreSignUpExternalProviderTriggerEvent } from 'aws-lambda';
import { handler, isAllowlisted, parseAllowlist } from './preSignUpTrigger';

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

function buildEvent(
  email: string | undefined,
): PreSignUpExternalProviderTriggerEvent {
  return {
    version: '1',
    region: 'eu-north-1',
    userPoolId: 'eu-north-1_test',
    triggerSource: 'PreSignUp_ExternalProvider',
    userName: 'Google_1234567890',
    callerContext: {
      awsSdkVersion: 'aws-sdk-unknown',
      clientId: 'test-client-id',
    },
    request: {
      userAttributes: email === undefined ? {} : { email },
    },
    response: {
      autoConfirmUser: false,
      autoVerifyEmail: false,
      autoVerifyPhone: false,
    },
  };
}

describe('handler', () => {
  const originalAllowlist = process.env.ALLOWLISTED_EMAILS;

  afterEach(() => {
    process.env.ALLOWLISTED_EMAILS = originalAllowlist;
  });

  it('lets an allowlisted email through and returns the event unchanged', async () => {
    process.env.ALLOWLISTED_EMAILS = 'me@example.com,wife@example.com';
    const event = buildEvent('me@example.com');

    await expect(handler(event, {} as never, () => undefined)).resolves.toBe(
      event,
    );
  });

  it('rejects a non-allowlisted email', async () => {
    process.env.ALLOWLISTED_EMAILS = 'me@example.com,wife@example.com';
    const event = buildEvent('stranger@example.com');

    await expect(
      handler(event, {} as never, () => undefined),
    ).rejects.toThrow();
  });

  it('rejects an event with no email claim at all', async () => {
    process.env.ALLOWLISTED_EMAILS = 'me@example.com,wife@example.com';
    const event = buildEvent(undefined);

    await expect(
      handler(event, {} as never, () => undefined),
    ).rejects.toThrow();
  });

  it('rejects everyone when ALLOWLISTED_EMAILS is unset', async () => {
    delete process.env.ALLOWLISTED_EMAILS;
    const event = buildEvent('me@example.com');

    await expect(
      handler(event, {} as never, () => undefined),
    ).rejects.toThrow();
  });
});
