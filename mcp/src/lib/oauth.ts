import { createHash } from 'node:crypto';
import {
  CreateManagedLoginBrandingCommand,
  CreateUserPoolClientCommand,
  DeleteUserPoolClientCommand,
  ListUserPoolClientsCommand,
} from '@aws-sdk/client-cognito-identity-provider';

export interface OAuthConfig {
  // The MCP origin, e.g. https://mcp.draupnir.nodm.name (no trailing slash).
  origin: string;
  // Cognito Managed Login base URL, e.g. https://draupnir-auth.auth.eu-north-1.amazoncognito.com
  cognitoDomainUrl: string;
  userPoolId: string;
  region: string;
}

// The only calls the shim makes; a real CognitoIdentityProviderClient fits.
export interface CognitoLike {
  send(command: unknown): Promise<unknown>;
}

export const CLIENT_NAME_PREFIX = 'mcp-dcr-';
export const MAX_CLIENTS = 25;
export const MAX_REDIRECT_URIS = 5;
export const SCOPES = ['openid', 'email', 'profile'];

// claude.ai and claude.com MCP connector callbacks (reports differ on the
// exact path; confirmed against the real clients in the change's task 4.1).
const CLAUDE_CALLBACKS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

export function protectedResourceMetadata(c: OAuthConfig) {
  return {
    resource: `${c.origin}/mcp`,
    authorization_servers: [c.origin],
    scopes_supported: ['openid'],
    bearer_methods_supported: ['header'],
  };
}

// Authorize and token requests go through the shim's `/authorize` redirect and
// `/token` forwarder, which strip `resource`: Cognito accepts it on authorize
// but then issues a code that cannot be redeemed (`invalid_grant`).
export function authorizationServerMetadata(c: OAuthConfig) {
  const pool = `https://cognito-idp.${c.region}.amazonaws.com/${c.userPoolId}`;
  return {
    issuer: c.origin,
    authorization_endpoint: `${c.origin}/authorize`,
    token_endpoint: `${c.origin}/token`,
    jwks_uri: `${pool}/.well-known/jwks.json`,
    registration_endpoint: `${c.origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  };
}

function isAllowedRedirectUri(value: string): boolean {
  if (CLAUDE_CALLBACKS.includes(value)) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const port = Number(url.port);
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTS.includes(url.hostname) &&
    url.port !== '' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    // Re-serializing must not change what was requested, so Cognito stores
    // exactly the URI the client will send.
    url.href === value
  );
}

export type Validated =
  | { ok: true; uris: string[] }
  | { ok: false; error: string; description: string };

export function validateRedirectUris(value: unknown): Validated {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((v) => typeof v === 'string')
  ) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: 'redirect_uris must be a non-empty array of strings',
    };
  }
  const uris = [...new Set(value as string[])].sort();
  if (uris.length > MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: `at most ${MAX_REDIRECT_URIS} redirect_uris`,
    };
  }
  const rejected = uris.find((u) => !isAllowedRedirectUri(u));
  if (rejected !== undefined) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: 'redirect URI is not allowed',
    };
  }
  return { ok: true, uris };
}

export function clientNameFor(sortedUris: string[]): string {
  const hash = createHash('sha256')
    .update(sortedUris.join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `${CLIENT_NAME_PREFIX}${hash}`;
}

export interface RegisterResult {
  status: number;
  body: Record<string, unknown>;
}

function registrationBody(clientId: string, uris: string[]) {
  return {
    client_id: clientId,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: SCOPES.join(' '),
  };
}

async function listRegisteredClients(
  cognito: CognitoLike,
  userPoolId: string,
): Promise<{ id: string; name: string }[]> {
  const found: { id: string; name: string }[] = [];
  let nextToken: string | undefined;
  do {
    const page = (await cognito.send(
      new ListUserPoolClientsCommand({
        UserPoolId: userPoolId,
        MaxResults: 60,
        NextToken: nextToken,
      }),
    )) as {
      UserPoolClients?: { ClientId?: string; ClientName?: string }[];
      NextToken?: string;
    };
    for (const c of page.UserPoolClients ?? []) {
      if (c.ClientId && c.ClientName?.startsWith(CLIENT_NAME_PREFIX)) {
        found.push({ id: c.ClientId, name: c.ClientName });
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return found;
}

export async function registerClient(
  cognito: CognitoLike,
  c: OAuthConfig,
  requestBody: unknown,
): Promise<RegisterResult> {
  const input =
    typeof requestBody === 'object' && requestBody !== null
      ? (requestBody as Record<string, unknown>)
      : {};
  const validated = validateRedirectUris(input['redirect_uris']);
  if (!validated.ok) {
    return {
      status: 400,
      body: {
        error: validated.error,
        error_description: validated.description,
      },
    };
  }

  const name = clientNameFor(validated.uris);
  const existing = await listRegisteredClients(cognito, c.userPoolId);
  const known = existing.find((e) => e.name === name);
  if (known) {
    return { status: 201, body: registrationBody(known.id, validated.uris) };
  }
  if (existing.length >= MAX_CLIENTS) {
    return {
      status: 429,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'client registration limit reached',
      },
    };
  }

  const created = (await cognito.send(
    new CreateUserPoolClientCommand({
      UserPoolId: c.userPoolId,
      ClientName: name,
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: SCOPES,
      CallbackURLs: validated.uris,
      SupportedIdentityProviders: ['Google'],
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
    }),
  )) as { UserPoolClient?: { ClientId?: string } };
  const clientId = created.UserPoolClient?.ClientId;
  if (!clientId) {
    throw new Error('Cognito returned no client id');
  }

  // A new app client is unusable in Managed Login until a branding style is
  // attached (see infra/lib/cognito.ts); undo the client rather than leak it.
  try {
    await cognito.send(
      new CreateManagedLoginBrandingCommand({
        UserPoolId: c.userPoolId,
        ClientId: clientId,
        UseCognitoProvidedValues: true,
      }),
    );
  } catch (e) {
    await cognito.send(
      new DeleteUserPoolClientCommand({
        UserPoolId: c.userPoolId,
        ClientId: clientId,
      }),
    );
    throw e;
  }

  return { status: 201, body: registrationBody(clientId, validated.uris) };
}

export interface TokenResult {
  status: number;
  body: string;
  contentType: string;
}

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

// Forwards a form-encoded token request to Cognito with `resource` removed.
// Nothing is logged or stored: the body carries codes, verifiers and tokens.
export async function forwardToken(
  fetchFn: FetchLike,
  c: OAuthConfig,
  rawBody: string | undefined,
): Promise<TokenResult> {
  const params = new URLSearchParams(rawBody ?? '');
  params.delete('resource');
  const grant = params.get('grant_type');
  if (grant !== 'authorization_code' && grant !== 'refresh_token') {
    return {
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unsupported_grant_type' }),
    };
  }
  const res = await fetchFn(`${c.cognitoDomainUrl}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? 'application/json',
    body: await res.text(),
  };
}

// Location of the user pool's authorize endpoint for a client request, with
// `resource` removed. The target host is fixed, so this cannot redirect elsewhere.
export function authorizeRedirect(
  c: OAuthConfig,
  query: Record<string, string[] | undefined> | null,
): string {
  const params = new URLSearchParams();
  for (const [key, values] of Object.entries(query ?? {})) {
    if (key === 'resource') {
      continue;
    }
    for (const value of values ?? []) {
      params.append(key, value);
    }
  }
  return `${c.cognitoDomainUrl}/oauth2/authorize?${params.toString()}`;
}
