import { CognitoJwtVerifier } from 'aws-jwt-verify';

export interface VerifiedIdentity {
  sub: string;
  email: string;
}

export type IdTokenVerifier = (idToken: string) => Promise<VerifiedIdentity>;

// Verifies signature, issuer, audience (the bot's app client), expiry and that
// it is an ID token. Throws on anything else.
export function createIdTokenVerifier(options: {
  userPoolId: string;
  clientId: string;
  // Test hook: the verifier accepts a pre-populated key set.
  verifier?: Pick<ReturnType<typeof CognitoJwtVerifier.create>, 'verify'>;
}): IdTokenVerifier {
  const verifier =
    options.verifier ??
    CognitoJwtVerifier.create({
      userPoolId: options.userPoolId,
      clientId: options.clientId,
      tokenUse: 'id',
    });
  return async (idToken) => {
    const payload = await verifier.verify(idToken);
    const email = payload['email'];
    if (typeof email !== 'string' || email === '') {
      throw new Error('ID token has no email claim');
    }
    return { sub: payload.sub, email };
  };
}
