import { domainToASCII } from 'node:url';

/**
 * Pragmatic address syntax check.
 *
 * Deliberately stricter than RFC 5322: quoted local parts, IP-literal domains and
 * non-ASCII local parts are valid on paper but are almost never real outreach
 * targets and most receiving servers reject them, so they are reported as errors.
 * Internationalised domains are accepted and converted to punycode.
 */
export type SyntaxErrorCode =
  | 'empty'
  | 'no_at'
  | 'multiple_at'
  | 'local_empty'
  | 'local_too_long'
  | 'local_invalid'
  | 'non_ascii_local'
  | 'quoted_local_unsupported'
  | 'ip_literal_unsupported'
  | 'domain_invalid'
  | 'address_too_long';

export interface ParsedAddress {
  local: string;
  domain: string;
  /** Lower-cased `local@ascii-domain`; used as the dedup key. */
  normalized: string;
}

export type ParseResult =
  | { ok: true; address: ParsedAddress }
  | { ok: false; error: SyntaxErrorCode };

// RFC 5322 atext.
const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
// RFC 1035 label after IDNA conversion (lower-case ASCII).
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NON_ASCII = /[^\x00-\x7f]/;

const MAX_LOCAL = 64;
const MAX_ADDRESS = 254; // RFC 5321 path limit (256) minus the angle brackets.
const MAX_DOMAIN = 253;

const fail = (error: SyntaxErrorCode): ParseResult => ({ ok: false, error });

export function parseAddress(input: string): ParseResult {
  let s = input.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  if (s.toLowerCase().startsWith('mailto:')) s = s.slice('mailto:'.length);
  if (s.length === 0) return fail('empty');
  if (s.startsWith('"')) return fail('quoted_local_unsupported');

  const at = s.lastIndexOf('@');
  if (at === -1) return fail('no_at');
  if (s.indexOf('@') !== at) return fail('multiple_at');

  const rawLocal = s.slice(0, at);
  const rawDomain = s.slice(at + 1);

  if (rawLocal.length === 0) return fail('local_empty');
  if (rawLocal.length > MAX_LOCAL) return fail('local_too_long');
  if (NON_ASCII.test(rawLocal)) return fail('non_ascii_local');
  // dot-atom: no empty atoms means no leading, trailing or consecutive dots.
  if (!rawLocal.split('.').every((atom) => atom.length > 0 && ATEXT.test(atom))) {
    return fail('local_invalid');
  }

  if (rawDomain.startsWith('[')) return fail('ip_literal_unsupported');
  const domain = normalizeDomain(rawDomain);
  if (domain === null) return fail('domain_invalid');

  const local = rawLocal.toLowerCase();
  const normalized = `${local}@${domain}`;
  if (normalized.length > MAX_ADDRESS) return fail('address_too_long');

  return { ok: true, address: { local, domain, normalized } };
}

/** Returns the lower-case ASCII (punycode) form of a host name, or null if it is not a valid mail domain. */
export function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().replace(/\.$/, ''); // accept a fully-qualified trailing dot
  if (trimmed.length === 0) return null;

  const ascii = domainToASCII(trimmed); // '' when IDNA conversion fails
  if (ascii.length === 0 || ascii.length > MAX_DOMAIN) return null;

  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;

  const tld = labels[labels.length - 1]!;
  if (tld.length < 2 || /^[0-9]+$/.test(tld)) return null;

  return ascii;
}
