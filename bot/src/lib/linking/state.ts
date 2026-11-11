import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Signed, expiring `state` for the sign-in link:
//   base64url(payload) "." base64url(HMAC-SHA256(secret, payload))
// payload = 16-byte random nonce || 6-byte big-endian expiry (epoch seconds).
// Checking it needs no database, so the public callback can drop forged
// requests before they wake Aurora.
const NONCE_BYTES = 16;
const EXPIRY_BYTES = 6;
const PAYLOAD_BYTES = NONCE_BYTES + EXPIRY_BYTES;
const MAC_BYTES = 32;
const MAX_STATE_LENGTH = 256;

const mac = (secret: string, payload: Buffer): Buffer =>
  createHmac('sha256', secret).update(payload).digest();

export function signState(secret: string, now: Date, ttlMs: number): string {
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  randomBytes(NONCE_BYTES).copy(payload);
  payload.writeUIntBE(
    Math.floor((now.getTime() + ttlMs) / 1000),
    NONCE_BYTES,
    EXPIRY_BYTES,
  );
  return `${payload.toString('base64url')}.${mac(secret, payload).toString('base64url')}`;
}

// Decodes only the canonical spelling: Node ignores the unused low bits of the
// last base64url character, so other strings decode to the same bytes (and
// pass the signature) while hashing differently.
function decodeCanonical(part: string, bytes: number): Buffer | null {
  const decoded = Buffer.from(part, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== part) {
    return null;
  }
  return decoded;
}

// Never throws; any malformed input is simply invalid.
export function verifyState(secret: string, state: string, now: Date): boolean {
  if (state.length > MAX_STATE_LENGTH) return false;
  const parts = state.split('.');
  if (parts.length !== 2) return false;
  const [payloadPart, macPart] = parts as [string, string];

  const payload = decodeCanonical(payloadPart, PAYLOAD_BYTES);
  const given = decodeCanonical(macPart, MAC_BYTES);
  if (!payload || !given) return false;

  if (!timingSafeEqual(given, mac(secret, payload))) return false;

  const expiresAt = payload.readUIntBE(NONCE_BYTES, EXPIRY_BYTES);
  return Math.floor(now.getTime() / 1000) <= expiresAt;
}
