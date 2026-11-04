import type { LinkConfig } from './config';

// Authorization-code exchange with the confidential app client. Returns the ID
// token. The secret goes in the Authorization header, never the URL or logs.
export async function exchangeAuthorizationCode(
  config: LinkConfig,
  clientSecret: string,
  input: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`${config.cognitoBaseUrl}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${config.clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code: input.code,
      redirect_uri: config.callbackUrl,
      code_verifier: input.codeVerifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token endpoint returned ${response.status}`);
  }
  const body = (await response.json()) as { id_token?: string };
  if (!body.id_token) {
    throw new Error('Token response has no id_token');
  }
  return body.id_token;
}
