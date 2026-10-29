import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DnsMxResolver, StaticMxResolver, type DnsBackend } from '../src/dns.js';

const dnsError = (code: string) => Object.assign(new Error(code), { code });

function backend(table: {
  mx?: Record<string, { exchange: string; priority: number }[] | string>;
  a?: Record<string, string[] | string>;
  aaaa?: Record<string, string[] | string>;
}): DnsBackend {
  const answer = <T>(map: Record<string, T | string> | undefined, d: string): Promise<T> => {
    const v = map?.[d];
    if (v === undefined) return Promise.reject(dnsError('ENODATA'));
    if (typeof v === 'string') return Promise.reject(dnsError(v));
    return Promise.resolve(v);
  };
  return {
    resolveMx: (d) => answer(table.mx, d),
    resolve4: (d) => answer(table.a, d),
    resolve6: (d) => answer(table.aaaa, d),
  };
}

describe('DnsMxResolver', () => {
  it('sorts MX hosts by preference and strips trailing dots', async () => {
    const r = new DnsMxResolver(
      backend({
        mx: {
          'example.com': [
            { exchange: 'backup.example.com.', priority: 20 },
            { exchange: 'Primary.Example.com', priority: 10 },
          ],
        },
      }),
    );
    assert.deepEqual(await r.lookup('example.com'), {
      kind: 'mx',
      implicit: false,
      hosts: [
        { exchange: 'primary.example.com', priority: 10 },
        { exchange: 'backup.example.com', priority: 20 },
      ],
    });
  });

  it('recognises RFC 7505 null MX', async () => {
    const r = new DnsMxResolver(backend({ mx: { 'nomail.example': [{ exchange: '', priority: 0 }] } }));
    assert.deepEqual(await r.lookup('nomail.example'), { kind: 'null_mx' });
  });

  it('falls back to the A record when there is no MX (RFC 5321 implicit MX)', async () => {
    const r = new DnsMxResolver(backend({ a: { 'apex.example': ['203.0.113.7'] } }));
    assert.deepEqual(await r.lookup('apex.example'), {
      kind: 'mx',
      implicit: true,
      hosts: [{ exchange: 'apex.example', priority: 0 }],
    });
  });

  it('falls back to AAAA when there is no A either', async () => {
    const r = new DnsMxResolver(backend({ aaaa: { 'v6.example': ['2001:db8::1'] } }));
    const res = await r.lookup('v6.example');
    assert.equal(res.kind, 'mx');
  });

  it('returns none for NXDOMAIN without querying address records', async () => {
    let addressQueried = false;
    const b = backend({ mx: { 'gone.example': 'ENOTFOUND' } });
    b.resolve4 = async () => {
      addressQueried = true;
      return [];
    };
    assert.deepEqual(await new DnsMxResolver(b).lookup('gone.example'), { kind: 'none' });
    assert.equal(addressQueried, false);
  });

  it('returns none when there are no MX and no address records', async () => {
    assert.deepEqual(await new DnsMxResolver(backend({})).lookup('empty.example'), { kind: 'none' });
  });

  it('treats timeouts and SERVFAIL as temporary errors, not as "no MX"', async () => {
    const r = new DnsMxResolver(backend({ mx: { 'slow.example': 'ETIMEOUT', 'broken.example': 'ESERVFAIL' } }));
    assert.deepEqual(await r.lookup('slow.example'), { kind: 'error', code: 'ETIMEOUT' });
    assert.deepEqual(await r.lookup('broken.example'), { kind: 'error', code: 'ESERVFAIL' });
  });

  it('reports a temporary error during the A fallback as an error', async () => {
    const r = new DnsMxResolver(backend({ a: { 'flaky.example': 'ETIMEOUT' } }));
    assert.deepEqual(await r.lookup('flaky.example'), { kind: 'error', code: 'ETIMEOUT' });
  });
});

describe('StaticMxResolver', () => {
  it('answers from fixtures with a wildcard default', async () => {
    const r = new StaticMxResolver({
      'a.test': { kind: 'null_mx' },
      '*': { kind: 'mx', implicit: false, hosts: [{ exchange: 'mx.test', priority: 0 }] },
    });
    assert.deepEqual(await r.lookup('A.TEST'), { kind: 'null_mx' });
    assert.equal((await r.lookup('other.test')).kind, 'mx');
    assert.deepEqual(await new StaticMxResolver({}).lookup('x.test'), { kind: 'none' });
  });
});
