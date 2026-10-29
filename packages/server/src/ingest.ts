import { parseAddress } from '@mailprobe/core';

export interface IngestRow {
  /** Normalized address when valid, otherwise the trimmed raw input (kept so the user sees it in results). */
  email: string;
  domain: string | null;
}

export interface IngestResult {
  rows: IngestRow[];
  duplicatesRemoved: number;
  blankRemoved: number;
}

/**
 * Normalizes, dedupes and orders an upload before it touches the database.
 *
 * Rows are sorted by domain so that consecutive ids, and therefore each worker chunk,
 * hold addresses at the same domain: one MX lookup and one SMTP session can then
 * cover a whole chunk instead of one per address.
 */
export function prepareUpload(raw: readonly string[]): IngestResult {
  const seen = new Set<string>();
  const rows: IngestRow[] = [];
  let duplicatesRemoved = 0;
  let blankRemoved = 0;

  for (const input of raw) {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      blankRemoved++;
      continue;
    }
    const parsed = parseAddress(trimmed);
    const row: IngestRow = parsed.ok
      ? { email: parsed.address.normalized, domain: parsed.address.domain }
      : { email: trimmed.slice(0, 320), domain: null };
    const key = row.email.toLowerCase();
    if (seen.has(key)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(key);
    rows.push(row);
  }

  rows.sort((a, b) => {
    // Invalid rows (no domain) first: they finish instantly and do not touch the network.
    if (a.domain !== b.domain) {
      if (a.domain === null) return -1;
      if (b.domain === null) return 1;
      return a.domain < b.domain ? -1 : 1;
    }
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });

  return { rows, duplicatesRemoved, blankRemoved };
}

/** Splits a sorted list of row ids into [fromId, toId] ranges of at most `size` rows. */
export function chunkIdRanges(ids: readonly number[], size: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < ids.length; i += size) {
    const slice = ids.slice(i, i + size);
    out.push([slice[0]!, slice[slice.length - 1]!]);
  }
  return out;
}
