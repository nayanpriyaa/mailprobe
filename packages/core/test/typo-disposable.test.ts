import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainSet, loadDisposableDomains } from '../src/disposable.js';
import { boundedOsaDistance, suggestDomain } from '../src/typo.js';

/** Reference implementation: unbounded OSA, O(n*m). */
function osa(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
}

describe('boundedOsaDistance', () => {
  it('counts transposition as one edit', () => {
    assert.equal(boundedOsaDistance('gmial.com', 'gmail.com', 2), 1);
  });

  it('matches the unbounded reference within the bound and caps above it', () => {
    const words = ['gmail.com', 'gmial.com', 'gmal.com', 'hotmail.com', 'hotmial.co', 'yahoo.com', 'yaho.com', 'abc', '', 'x'];
    for (const a of words) {
      for (const b of words) {
        for (const max of [0, 1, 2, 3]) {
          const ref = osa(a, b);
          assert.equal(boundedOsaDistance(a, b, max), ref <= max ? ref : max + 1, `${a} vs ${b} max=${max}`);
        }
      }
    }
  });
});

describe('suggestDomain', () => {
  const cases: Array<[string, string | null]> = [
    ['gmial.com', 'gmail.com'],
    ['gmail.co', 'gmail.com'],
    ['gamil.com', 'gmail.com'],
    ['hotmal.com', 'hotmail.com'],
    ['yaho.com', 'yahoo.com'],
    ['outlok.com', 'outlook.com'],
    ['acme.con', 'acme.com'],
    ['gmail.com', null],
    ['mail.com', null], // popular itself; must not "correct" to gmail.com
    ['acme.com', null],
    ['stripe.com', null],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => assert.equal(suggestDomain(input), expected));
  }
});

describe('DomainSet', () => {
  const set = new DomainSet(['mailinator.com', 'tempmail.dev', '# comment', '']);

  it('matches exact and parent domains', () => {
    assert.ok(set.has('mailinator.com'));
    assert.ok(set.has('foo.mailinator.com'));
    assert.ok(set.has('a.b.MAILINATOR.com'));
  });

  it('does not match siblings or bare TLDs', () => {
    assert.equal(set.has('notmailinator.com'), false);
    assert.equal(set.has('com'), false);
    assert.equal(set.size, 2);
  });

  it('loads the bundled list', () => {
    const bundled = loadDisposableDomains();
    assert.ok(bundled.size > 1000);
    assert.ok(bundled.has('mailinator.com'));
    assert.equal(bundled.has('gmail.com'), false);
  });
});
