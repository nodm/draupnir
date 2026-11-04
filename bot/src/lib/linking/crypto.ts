import { createHash, randomBytes, randomInt } from 'node:crypto';

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

// URL-safe, unguessable. 32 bytes = 43 characters.
export const randomToken = (bytes = 32): string =>
  randomBytes(bytes).toString('base64url');

// RFC 7636 S256 code challenge.
export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export const confirmationCode = (): string =>
  String(randomInt(0, 1_000_000)).padStart(6, '0');
