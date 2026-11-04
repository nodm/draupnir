export interface LinkConfig {
  // Cognito hosted-UI base, e.g. https://<prefix>.auth.<region>.amazoncognito.com
  cognitoBaseUrl: string;
  clientId: string;
  callbackUrl: string;
  botUsername: string;
}

export const LINK_REQUEST_TTL_MS = 10 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

export function loadLinkConfigFromEnv(): LinkConfig {
  return {
    cognitoBaseUrl: requireEnv('COGNITO_BASE_URL').replace(/\/$/, ''),
    clientId: requireEnv('TELEGRAM_CLIENT_ID'),
    callbackUrl: requireEnv('TELEGRAM_CALLBACK_URL'),
    botUsername: requireEnv('BOT_USERNAME').replace(/^@/, ''),
  };
}
