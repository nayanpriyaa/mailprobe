import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvField, csvRow, extractEmailColumn, parseCsv } from '../src/csv.js';
import { decodeCursor, encodeCursor, InvalidCursorError } from '../src/cursor.js';
import { chunkIdRanges, prepareUpload } from '../src/ingest.js';
import { generateApiKey, hashApiKey, KEY_PATTERN } from '../src/keys.js';
import { ULID_PATTERN, ulid } from '../src/ulid.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF, BOM and blank lines', () => {
    const text = '﻿name,email\r\n"Doe, Jane","jane@x.com"\r\n\r\n"He said ""hi""",bob@y.com\nlast,c@z.com';
    assert.deepEqual(parseCsv(text), [
      ['name', 'email'],
      ['Doe, Jane', 'jane@x.com'],
      ['He said "hi"', 'bob@y.com'],
      ['last', 'c@z.com'],
    ]);
  });

  it('keeps newlines inside quoted fields', () => {
    assert.deepEqual(parseCsv('"a\nb",c\n'), [['a\nb', 'c']]);
  });
});

describe('extractEmailColumn', () => {
  it('uses a header named like email', () => {
    assert.deepEqual(extractEmailColumn([['Name', 'E-mail'], ['A', ' a@x.com '], ['B']]), ['a@x.com', '']);
  });

  it('detects the column with "@" when there is no recognisable header', () => {
    const rows = [['first', 'contact', 'company'], ['A', 'a@x.com', 'X'], ['B', 'b@y.com', 'Y']];
    assert.deepEqual(extractEmailColumn(rows), ['a@x.com', 'b@y.com']);
  });

  it('handles a bare list of addresses without a header', () => {
    assert.deepEqual(extractEmailColumn([['a@x.com'], ['b@y.com']]), ['a@x.com', 'b@y.com']);
  });
});

describe('csvField', () => {
  it('quotes when needed and defuses formulas', () => {
    assert.equal(csvField('plain'), 'plain');
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('say "x"'), '"say ""x"""');
    assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvField(null), '');
    assert.equal(csvRow(['a', 1, true]), 'a,1,true\r\n');
  });
});

describe('prepareUpload', () => {
  it('normalizes, dedupes case-insensitively, drops blanks and groups by domain', () => {
    const r = prepareUpload(['b@zeta.com', 'A@Acme.com', ' a@acme.com', '', 'nope', 'c@acme.com', 'NOPE', 'z@beta.io']);
    assert.deepEqual(
      r.rows.map((x) => x.email),
      ['nope', 'a@acme.com', 'c@acme.com', 'z@beta.io', 'b@zeta.com'],
    );
    assert.equal(r.duplicatesRemoved, 2);
    assert.equal(r.blankRemoved, 1);
    assert.equal(r.rows[0]!.domain, null);
  });
});

describe('chunkIdRanges', () => {
  it('splits non-contiguous ids into ranges by row count', () => {
    assert.deepEqual(chunkIdRanges([1, 2, 3, 7, 8, 20, 21], 3), [
      [1, 3],
      [7, 20],
      [21, 21],
    ]);
    assert.deepEqual(chunkIdRanges([], 3), []);
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    assert.equal(decodeCursor(encodeCursor(12345)), 12345);
    assert.equal(decodeCursor(undefined), null);
    assert.throws(() => decodeCursor('not-a-cursor'), InvalidCursorError);
    assert.throws(() => decodeCursor(Buffer.from('v1:1; DROP TABLE').toString('base64url')), InvalidCursorError);
  });
});

describe('api keys', () => {
  it('generates well-formed unique keys and hashes deterministically', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    assert.match(a.plaintext, KEY_PATTERN);
    assert.notEqual(a.plaintext, b.plaintext);
    assert.equal(a.prefix, a.plaintext.slice(0, 12));
    assert.deepEqual(hashApiKey(a.plaintext), a.hash);
    assert.equal(a.hash.length, 32);
  });
});

describe('ulid', () => {
  it('is 26 chars, valid alphabet and time-sortable', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    assert.match(a, ULID_PATTERN);
    assert.ok(a < b);
    assert.equal(ulid(0).slice(0, 10), '0000000000');
  });
});
