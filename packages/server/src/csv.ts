/**
 * RFC 4180 CSV reading and writing, scoped to what uploads need: quoted fields,
 * escaped quotes, CRLF/LF line endings, a BOM, and ragged rows.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // strip UTF-8 BOM (Excel adds one)

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row); // skip blank lines
    row = [];
  };

  for (; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field.length === 0) {
      inQuotes = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n') {
      endRow();
    } else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

const HEADER_NAMES = new Set(['email', 'e-mail', 'email address', 'email_address', 'emailaddress', 'mail']);

/**
 * Pulls the email column out of an uploaded CSV. Uses a header named like "email"
 * if there is one; otherwise the first column in which most sampled cells contain "@".
 * A single-column file without a header (just addresses) works too.
 */
export function extractEmailColumn(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const named = header.findIndex((h) => HEADER_NAMES.has(h));
  if (named !== -1) return rows.slice(1).map((r) => (r[named] ?? '').trim());

  const sample = rows.slice(0, 50);
  const width = Math.max(...sample.map((r) => r.length));
  let best = 0;
  let bestHits = -1;
  for (let col = 0; col < width; col++) {
    const hits = sample.filter((r) => (r[col] ?? '').includes('@')).length;
    if (hits > bestHits) {
      best = col;
      bestHits = hits;
    }
  }
  // Treat row 0 as a header if it has no "@" in the chosen column.
  const hasHeader = !(rows[0]![best] ?? '').includes('@');
  return (hasHeader ? rows.slice(1) : rows).map((r) => (r[best] ?? '').trim());
}

/** Quotes a field when needed, and defuses spreadsheet formula injection ("=HYPERLINK(...)"). */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (values: readonly unknown[]): string => `${values.map(csvField).join(',')}\r\n`;
