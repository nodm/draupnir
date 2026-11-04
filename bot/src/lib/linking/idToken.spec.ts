import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createIdTokenVerifier } from './idToken';

const POOL = 'eu-north-1_Test12345';
const CLIENT = 'telegram-client';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) };
}

const signing = keyPair();
const otherKey = keyPair();

const b64 = (value: object | Buffer) =>
  (Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(value))
  ).toString('base64url');

function jwt(
  payload: Record<string, unknown>,
  key: KeyObject = signing.privateKey,
) {
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = b64({
    iss: `https://cognito-idp.eu-north-1.amazonaws.com/${POOL}`,
    aud: CLIENT,
    token_use: 'id',
    sub: 'user-sub',
    email: 'ann@example.com',
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...payload,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64(signature)}`;
}

function verifier() {
  const real = CognitoJwtVerifier.create({
    userPoolId: POOL,
    clientId: CLIENT,
    tokenUse: 'id',
  });
  // Mocked JWKS: no network.
  real.cacheJwks({
    keys: [{ ...signing.jwk, kid: 'k1', alg: 'RS256', use: 'sig' }],
  } as never);
  return createIdTokenVerifier({
    userPoolId: POOL,
    clientId: CLIENT,
    verifier: real,
  });
}

describe('createIdTokenVerifier', () => {
  it('returns sub and email from a valid ID token', async () => {
    await expect(verifier()(jwt({}))).resolves.toEqual({
      sub: 'user-sub',
      email: 'ann@example.com',
    });
  });

  it('rejects a token for another app client', async () => {
    await expect(verifier()(jwt({ aud: 'someone-else' }))).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect(
      verifier()(jwt({ iat: past - 60, exp: past })),
    ).rejects.toThrow();
  });

  it('rejects a token signed by a different key', async () => {
    await expect(verifier()(jwt({}, otherKey.privateKey))).rejects.toThrow();
  });

  it('rejects an access token', async () => {
    await expect(
      verifier()(jwt({ token_use: 'access', client_id: CLIENT })),
    ).rejects.toThrow();
  });

  it('rejects a token from another issuer', async () => {
    await expect(
      verifier()(jwt({ iss: 'https://evil.example.com/pool' })),
    ).rejects.toThrow();
  });

  it('rejects a token without an email claim', async () => {
    await expect(verifier()(jwt({ email: undefined }))).rejects.toThrow(
      /email/,
    );
  });
});
