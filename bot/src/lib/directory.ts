import {
  ListUsersCommand,
  type CognitoIdentityProviderClient,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';

// Who is registered with Draupnir: the Cognito user pool (ADR-0002). The
// bot's database holds subs only; emails live here.
export interface UserDirectory {
  findByEmail(email: string): Promise<{ sub: string; email: string } | null>;
  emailOf(sub: string): Promise<string | null>;
}

const attribute = (user: UserType | undefined, name: string) =>
  user?.Attributes?.find((a) => a.Name === name)?.Value;

// Cognito filters are `attr = "value"`; a quote or backslash in the value would
// change the filter, so such values never get that far.
const SAFE_FILTER_VALUE = /^[^"\\\s]+$/;

export function createCognitoDirectory(
  client: Pick<CognitoIdentityProviderClient, 'send'>,
  userPoolId: string,
): UserDirectory {
  async function first(attr: 'email' | 'sub', value: string) {
    if (!SAFE_FILTER_VALUE.test(value)) return undefined;
    const { Users } = await client.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `${attr} = "${value}"`,
        Limit: 1,
      }),
    );
    return Users?.[0];
  }

  return {
    async findByEmail(email) {
      const user = await first('email', email);
      const sub = attribute(user, 'sub');
      return sub ? { sub, email: attribute(user, 'email') ?? email } : null;
    },
    async emailOf(sub) {
      return attribute(await first('sub', sub), 'email') ?? null;
    },
  };
}
