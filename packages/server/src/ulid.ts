import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O, U (avoids misreading ids aloud or in logs).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID: 48-bit millisecond timestamp + 80 random bits, 26 chars, lexicographically
 * sortable by creation time. Small enough to not justify a dependency.
 */
export function ulid(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 2 ** 48 - 1) throw new RangeError('timestamp out of range');
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  // 80 random bits = 16 base32 chars. Take 5 bits from each of 16 bytes' low end.
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! & 31];
  return time + rand;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
