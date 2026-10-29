import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FakeSmtpServer } from '@mailprobe/fake-smtp';
import { DomainSet } from '../src/disposable.js';
import { StaticMxResolver, type MxLookup } from '../src/dns.js';
import { InMemoryHostLimiter } from '../src/limiter.js';
import { DEFAULT_PROBE_OPTIONS } from '../src/smtp/probe.js';
import { InMemoryCache } from '../src/util.js';
import { Verifier } from '../src/verifier.js';

const mx = (...hosts: string[]): MxLookup => ({
  kind: 'mx',
  implicit: false,
  hosts: hosts.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 })),
});

const fixtures: Record<string, MxLookup> = {
  'acme.test': mx('mx1.acme.test'),
  'gmail.com': mx('gmail-smtp-in.l.google.com'),
  'catchall.test': mx('mx.catchall.test'),
  'nomx.test': { kind: 'none' },
  'nullmx.test': { kind: 'null_mx' },
  'dnsfail.test': { kind: 'error', code: 'ETIMEOUT' },
};

describe('Verifier', () => {
  const server = new FakeSmtpServer({ catchAllDomains: ['catchall.test'] });
  let port = 0;
  before(async () => (port = await server.start()));
  after(() => server.stop());

  const make = (overrides: { smtp?: boolean; cache?: InMemoryCache; limiter?: InMemoryHostLimiter } = {}) =>
    new Verifier(
      {
        resolver: new StaticMxResolver(fixtures),
        disposable: new DomainSet(['mailinator.com']),
        cache: overrides.cache,
        limiter: overrides.limiter,
      },
      {
        smtp:
          overrides.smtp === false
            ? null
            : {
                ...DEFAULT_PROBE_OPTIONS,
                heloName: 'probe.test',
                mailFrom: 'verify@probe.test',
                port,
                hostOverride: '127.0.0.1',
                connectTimeoutMs: 1000,
                commandTimeoutMs: 1000,
              },
      },
    );

  it('produces one verdict per input, in order, across every layer', async () => {
    const inputs = [
      'alice@acme.test',
      'bounce@acme.test',
      'not-an-email',
      'x@mailinator.com',
      'someone@nomx.test',
      'someone@nullmx.test',
      'someone@dnsfail.test',
      'anyone@catchall.test',
      'info@acme.test',
      'grey@acme.test',
    ];
    const results = await make().verifyBatch(inputs);
    assert.deepEqual(
      results.map((r) => [r.input, r.status, r.reason]),
      [
        ['alice@acme.test', 'deliverable', 'accepted'],
        ['bounce@acme.test', 'undeliverable', 'mailbox_not_found'],
        ['not-an-email', 'undeliverable', 'invalid_syntax'],
        ['x@mailinator.com', 'risky', 'disposable'],
        ['someone@nomx.test', 'undeliverable', 'no_mx'],
        ['someone@nullmx.test', 'undeliverable', 'null_mx'],
        ['someone@dnsfail.test', 'unknown', 'dns_error'],
        ['anyone@catchall.test', 'risky', 'catch_all'],
        ['info@acme.test', 'deliverable', 'accepted'],
        ['grey@acme.test', 'unknown', 'greylisted'],
      ],
    );

    const byInput = Object.fromEntries(results.map((r) => [r.input, r]));
    assert.equal(byInput['not-an-email']!.syntaxError, 'no_at');
    assert.equal(byInput['info@acme.test']!.role, true);
    assert.ok(byInput['info@acme.test']!.score < byInput['alice@acme.test']!.score);
    assert.equal(byInput['grey@acme.test']!.retryable, true);
    assert.equal(byInput['alice@acme.test']!.mxHost, 'mx1.acme.test');
    assert.equal(byInput['alice@acme.test']!.smtpCode, 250);
    assert.equal(byInput['alice@acme.test']!.catchAll, false);
  });

  it('flags free providers and suggests typo fixes', async () => {
    const v = make({ smtp: false });
    const [gmail, typo] = await v.verifyBatch(['someone@gmail.com', 'someone@gmial.com']);
    assert.equal(gmail!.free, true);
    assert.equal(gmail!.reason, 'smtp_disabled');
    assert.equal(typo!.reason, 'no_mx');
    assert.equal(typo!.suggestion, 'gmail.com');
  });

  it('dedupes addresses case-insensitively but echoes each input', async () => {
    const before = server.stats.rcptCommands;
    const results = await make().verifyBatch(['Bob@ACME.test', 'bob@acme.test', ' bob@acme.test ']);
    assert.deepEqual(
      results.map((r) => [r.input, r.email]),
      [
        ['Bob@ACME.test', 'bob@acme.test'],
        ['bob@acme.test', 'bob@acme.test'],
        [' bob@acme.test ', 'bob@acme.test'],
      ],
    );
    assert.equal(server.stats.rcptCommands - before, 2); // catch-all probe + bob, once
  });

  it('caches MX and catch-all results across batches', async () => {
    const cache = new InMemoryCache();
    const v = make({ cache });
    await v.verifyBatch(['a@acme.test', 'a@catchall.test']);
    const rcptBefore = server.stats.rcptCommands;
    await v.verifyBatch(['b@acme.test', 'b@catchall.test', 'c@catchall.test']);
    assert.equal(v.metrics.dnsLookups, 2);
    assert.equal(v.metrics.mxCacheHits, 2);
    assert.equal(v.metrics.catchAllCacheHits, 1);
    // Second batch: acme needs only "b" (catch-all known false), catchall.test needs nothing.
    assert.equal(server.stats.rcptCommands - rcptBefore, 1);
  });

  it('coalesces concurrent MX lookups for the same domain', async () => {
    let calls = 0;
    const resolver = {
      lookup: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return mx('mx.acme.test');
      },
    };
    const v = new Verifier({ resolver, disposable: new DomainSet([]) }, { smtp: null });
    await Promise.all(Array.from({ length: 10 }, (_, i) => v.verify(`u${i}@acme.test`)));
    assert.equal(calls, 1);
  });

  it('respects the per-host connection limit under load', async () => {
    const latent = new FakeSmtpServer({ latencyMs: 5 });
    const p = await latent.start();
    try {
      const domains = Array.from({ length: 12 }, (_, i) => `d${i}.test`);
      const v = new Verifier(
        {
          resolver: new StaticMxResolver({ '*': mx('shared-mx.test') }),
          disposable: new DomainSet([]),
          limiter: new InMemoryHostLimiter(3, 10_000),
        },
        {
          domainConcurrency: 12,
          smtp: {
            ...DEFAULT_PROBE_OPTIONS,
            heloName: 'probe.test',
            mailFrom: 'verify@probe.test',
            port: p,
            hostOverride: '127.0.0.1',
            connectTimeoutMs: 1000,
            commandTimeoutMs: 1000,
          },
        },
      );
      const results = await v.verifyBatch(domains.map((d) => `user@${d}`));
      assert.ok(results.every((r) => r.status === 'deliverable'));
      assert.equal(latent.stats.connections, 12);
      assert.ok(latent.stats.maxConcurrentConnections <= 3, `peak ${latent.stats.maxConcurrentConnections}`);
    } finally {
      await latent.stop();
    }
  });
});
