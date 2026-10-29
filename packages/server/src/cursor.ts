/**
 * Opaque keyset-pagination cursors. Clients get "next_cursor" and pass it back; the
 * id inside is an implementation detail and may change shape later.
 *
 * Keyset (WHERE id > ? ORDER BY id LIMIT n) instead of OFFSET: OFFSET makes MySQL
 * read and discard every skipped row, so page 1000 of a 50k-row job costs 1000x page 1.
 * See docs/DB-OPTIMIZATION.md for the EXPLAIN comparison.
 */
export function encodeCursor(id: number): string {
  return Buffer.from(`v1:${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString();
  const m = /^v1:(\d{1,18})$/.exec(raw);
  if (!m) throw new InvalidCursorError();
  return Number(m[1]);
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
  }
}
