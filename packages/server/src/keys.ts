import { createHash, randomBytes } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_PREFIX = 'mp_live_';
const RANDOM_CHARS = 32; // 32 * log2(62) ≈ 190 bits
export const KEY_PATTERN = /^mp_live_[0-9A-Za-z]{32}$/;

export interface GeneratedKey {
  /** Full key, returned to the user exactly once. */
  plaintext: string;
  /** Shown in listings, e.g. "mp_live_8fK2". */
  prefix: string;
  hash: Buffer;
}

export function generateApiKey(): GeneratedKey {
  // Rejection sampling: 248 = 62 * 4, so bytes >= 248 are discarded to keep the
  // distribution uniform (plain `byte % 62` would bias the first 8 characters).
  let body = '';
  while (body.length < RANDOM_CHARS) {
    for (const b of randomBytes(RANDOM_CHARS)) {
      if (b < 248 && body.length < RANDOM_CHARS) body += BASE62[b % 62];
    }
  }
  const plaintext = KEY_PREFIX + body;
  return { plaintext, prefix: plaintext.slice(0, KEY_PREFIX.length + 4), hash: hashApiKey(plaintext) };
}

export function hashApiKey(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext).digest();
}
