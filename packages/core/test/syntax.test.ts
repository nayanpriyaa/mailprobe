import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeDomain, parseAddress } from '../src/syntax.js';

describe('parseAddress', () => {
  const valid: Array<[string, string]> = [
    ['john@example.com', 'john@example.com'],
    ['  John.Doe@Example.COM ', 'john.doe@example.com'],
    ['first+tag@sub.example.co.in', 'first+tag@sub.example.co.in'],
    ["o'brien@example.ie", "o'brien@example.ie"],
    ['<wrapped@example.com>', 'wrapped@example.com'],
    ['mailto:user@example.com', 'user@example.com'],
    ['user@example.com.', 'user@example.com'],
    ['user@münchen.de', 'user@xn--mnchen-3ya.de'],
    ['a@b.io', 'a@b.io'],
  ];
  for (const [input, normalized] of valid) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      const r = parseAddress(input);
      assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
      assert.equal(r.address.normalized, normalized);
    });
  }

  const invalid: Array<[string, string]> = [
    ['', 'empty'],
    ['plainaddress', 'no_at'],
    ['a@b@example.com', 'multiple_at'],
    ['@example.com', 'local_empty'],
    ['.john@example.com', 'local_invalid'],
    ['john.@example.com', 'local_invalid'],
    ['jo..hn@example.com', 'local_invalid'],
    ['jo hn@example.com', 'local_invalid'],
    [`${'a'.repeat(65)}@example.com`, 'local_too_long'],
    ['"quoted"@example.com', 'quoted_local_unsupported'],
    ['user@[192.168.0.1]', 'ip_literal_unsupported'],
    ['józef@example.com', 'non_ascii_local'],
    ['user@localhost', 'domain_invalid'],
    ['user@-example.com', 'domain_invalid'],
    ['user@example-.com', 'domain_invalid'],
    ['user@exa_mple.com', 'domain_invalid'],
    ['user@example..com', 'domain_invalid'],
    ['user@example.c', 'domain_invalid'],
    ['user@example.123', 'domain_invalid'],
    [`user@${'a'.repeat(64)}.com`, 'domain_invalid'],
    [`${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}.com`, 'address_too_long'],
  ];
  for (const [input, error] of invalid) {
    it(`rejects ${JSON.stringify(input.length > 40 ? `${input.slice(0, 40)}…` : input)} as ${error}`, () => {
      const r = parseAddress(input);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, error);
    });
  }
});

describe('normalizeDomain', () => {
  it('lower-cases and punycodes', () => {
    assert.equal(normalizeDomain('EXAMPLE.com'), 'example.com');
    assert.equal(normalizeDomain('bücher.example'), 'xn--bcher-kva.example');
  });
  it('rejects single-label hosts', () => {
    assert.equal(normalizeDomain('intranet'), null);
  });
});
