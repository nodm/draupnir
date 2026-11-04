import { ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { createCognitoDirectory } from './directory';

const user = (sub: string, email: string) => ({
  Attributes: [
    { Name: 'sub', Value: sub },
    { Name: 'email', Value: email },
  ],
});

function directoryWith(users: unknown[] = []) {
  const send = vi.fn().mockResolvedValue({ Users: users });
  return { send, directory: createCognitoDirectory({ send }, 'pool-1') };
}

const sentFilter = (send: ReturnType<typeof vi.fn>) => {
  const command = send.mock.calls[0]?.[0] as ListUsersCommand;
  return command.input;
};

describe('createCognitoDirectory', () => {
  it('looks an email up with an exact filter on the configured pool', async () => {
    const { send, directory } = directoryWith([user('sub-1', 'a@example.com')]);

    expect(await directory.findByEmail('a@example.com')).toEqual({
      sub: 'sub-1',
      email: 'a@example.com',
    });
    expect(sentFilter(send)).toMatchObject({
      UserPoolId: 'pool-1',
      Filter: 'email = "a@example.com"',
      Limit: 1,
    });
  });

  it('looks an email up by sub with a sub filter', async () => {
    const { send, directory } = directoryWith([user('sub-1', 'a@example.com')]);

    expect(await directory.emailOf('sub-1')).toBe('a@example.com');
    expect(sentFilter(send).Filter).toBe('sub = "sub-1"');
  });

  it('returns null when nobody matches', async () => {
    const { directory } = directoryWith([]);
    expect(await directory.findByEmail('x@example.com')).toBeNull();
    expect(await directory.emailOf('nobody')).toBeNull();
  });

  it('returns null for a user without a sub attribute', async () => {
    const { directory } = directoryWith([{ Attributes: [] }]);
    expect(await directory.findByEmail('x@example.com')).toBeNull();
  });

  it.each([
    'a"b@example.com',
    'a\\b@example.com',
    'a b@example.com',
    'a"  or email = "b@example.com',
    '',
  ])('never sends %j to Cognito', async (value) => {
    const { send, directory } = directoryWith([user('s', 'a@example.com')]);

    expect(await directory.findByEmail(value)).toBeNull();
    expect(await directory.emailOf(value)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('passes a Cognito failure on to the caller', async () => {
    const send = vi.fn().mockRejectedValue(new Error('throttled'));
    const directory = createCognitoDirectory({ send }, 'pool-1');
    await expect(directory.findByEmail('a@example.com')).rejects.toThrow(
      'throttled',
    );
  });
});
