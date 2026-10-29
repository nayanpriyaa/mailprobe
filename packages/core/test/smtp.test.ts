import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FakeSmtpServer } from '@mailprobe/fake-smtp';
import { classifyOutcome, classifyRcptReply } from '../src/classify.js';
import { InMemoryHostLimiter } from '../src/limiter.js';
import { SmtpConnection } from '../src/smtp/connection.js';
import { DEFAULT_PROBE_OPTIONS, probeDomain, type ProbeOptions } from '../src/smtp/probe.js';

const opts = (port: number, extra: Partial<ProbeOptions> = {}): ProbeOptions => ({
  ...DEFAULT_PROBE_OPTIONS,
  heloName: 'probe.test',
  mailFrom: 'verify@probe.test',
  port,
  connectTimeoutMs: 1000,
  commandTimeoutMs: 1000,
  ...extra,
});

describe('SmtpConnection', () => {
  const server = new FakeSmtpServer();
  let port = 0;
  before(async () => (port = await server.start()));
  after(() => server.stop());

  it('reads the greeting and assembles multi-line replies', async () => {
    const c = await SmtpConnection.open('127.0.0.1', port, opts(port));
    assert.equal((await c.read()).code, 220);
    const ehlo = await c.command('EHLO probe.test');
    assert.equal(ehlo.code, 250);
    assert.match(ehlo.message, /PIPELINING/);
    assert.equal(ehlo.message.split('\n').length, 4);
    await c.close();
  });

  it('parses enhanced status codes', async () => {
    const c = await SmtpConnection.open('127.0.0.1', port, opts(port));
    await c.read();
    await c.command('EHLO probe.test');
    await c.command('MAIL FROM:<a@probe.test>');
    const r = await c.command('RCPT TO:<bounce@x.test>');
    assert.deepEqual([r.code, r.enhanced], [550, '5.1.1']);
    await c.close();
  });

  it('refuses commands containing CR/LF (SMTP injection)', async () => {
    const c = await SmtpConnection.open('127.0.0.1', port, opts(port));
    await c.read();
    await assert.rejects(c.command('RCPT TO:<a@b.test>\r\nDATA'), /CR\/LF/);
    await c.close();
  });
});

describe('probeDomain', () => {
  const server = new FakeSmtpServer({ catchAllDomains: ['catchall.test'] });
  let port = 0;
  before(async () => (port = await server.start()));
  after(() => server.stop());

  it('classifies each recipient from one session and detects non-catch-all domains', async () => {
    const before = server.stats.connections;
    const r = await probeDomain('acme.test', ['127.0.0.1'], ['alice', 'bounce1', 'full', 'block', 'grey1'], opts(port));
    assert.equal(server.stats.connections - before, 1);
    assert.equal(r.catchAll, false);
    const verdicts = Object.fromEntries([...r.outcomes].map(([k, o]) => [k, classifyOutcome(o).reason]));
    assert.deepEqual(verdicts, {
      alice: 'accepted',
      bounce1: 'mailbox_not_found',
      full: 'mailbox_full',
      block: 'smtp_blocked',
      grey1: 'greylisted',
    });
  });

  it('stops after the random probe on a catch-all domain', async () => {
    const rcptBefore = server.stats.rcptCommands;
    const r = await probeDomain('catchall.test', ['127.0.0.1'], ['a', 'b', 'c', 'd'], opts(port));
    assert.equal(r.catchAll, true);
    assert.equal(r.outcomes.size, 0);
    assert.equal(server.stats.rcptCommands - rcptBefore, 1);
  });

  it('skips the random probe when catch-all status is already known', async () => {
    const rcptBefore = server.stats.rcptCommands;
    await probeDomain('acme.test', ['127.0.0.1'], ['a', 'b'], opts(port), { knownCatchAll: false });
    assert.equal(server.stats.rcptCommands - rcptBefore, 2);
  });

  it('splits recipients across sessions at maxRcptPerSession', async () => {
    const before = server.stats.connections;
    const locals = Array.from({ length: 10 }, (_, i) => `user${i}`);
    const r = await probeDomain('acme.test', ['127.0.0.1'], locals, opts(port, { maxRcptPerSession: 4 }));
    // 1st session: probe + 3 users; then 4 + 3 (probe not repeated once conclusive).
    assert.equal(r.sessions, 3);
    assert.equal(server.stats.connections - before, 3);
    assert.equal(r.outcomes.size, 10);
    assert.ok([...r.outcomes.values()].every((o) => classifyOutcome(o).reason === 'accepted'));
  });

  it('learns the server recipient limit from 452 and carries the rest into a new session', async () => {
    const tight = new FakeSmtpServer({ maxRecipients: 3 });
    const p = await tight.start();
    try {
      const locals = Array.from({ length: 7 }, (_, i) => `user${i}`);
      const r = await probeDomain('acme.test', ['127.0.0.1'], locals, opts(p, { maxRcptPerSession: 20 }));
      // Session 1: probe + user0..1 accepted, user2 hits 452 -> limit learned as 3.
      // Then 3 per session: user2..4, user5..6.
      assert.equal(r.sessions, 3);
      assert.equal(r.outcomes.size, 7);
      assert.ok([...r.outcomes.values()].every((o) => classifyOutcome(o).reason === 'accepted'));
    } finally {
      await tight.stop();
    }
  });

  it('falls back to the next MX when the first refuses connections', async () => {
    // Nothing listens on 127.0.0.2:<port>; the server is bound to 127.0.0.1 only.
    const r = await probeDomain('acme.test', ['127.0.0.2', '127.0.0.1'], ['alice'], opts(port));
    assert.equal(r.mxHost, '127.0.0.1');
    assert.equal(classifyOutcome(r.outcomes.get('alice')!).reason, 'accepted');
  });

  it('reports smtp_unreachable when every MX refuses', async () => {
    const r = await probeDomain('acme.test', ['127.0.0.2', '127.0.0.3'], ['alice'], opts(port));
    assert.equal(r.mxHost, null);
    const v = classifyOutcome(r.outcomes.get('alice')!);
    assert.deepEqual([v.reason, v.retryable], ['smtp_unreachable', true]);
  });

  it('reports a policy block when MAIL FROM is rejected', async () => {
    const strict = new FakeSmtpServer({ rejectMailFrom: true });
    const p = await strict.start();
    try {
      const r = await probeDomain('acme.test', ['127.0.0.1'], ['alice', 'bob'], opts(p));
      for (const o of r.outcomes.values()) assert.equal(classifyOutcome(o).reason, 'smtp_blocked');
    } finally {
      await strict.stop();
    }
  });

  it('times out on a silent server and marks the result retryable', async () => {
    const silent = new FakeSmtpServer({ silent: true });
    const p = await silent.start();
    try {
      const started = Date.now();
      const r = await probeDomain('acme.test', ['127.0.0.1'], ['alice'], opts(p, { commandTimeoutMs: 150 }));
      assert.ok(Date.now() - started < 1000);
      const v = classifyOutcome(r.outcomes.get('alice')!);
      assert.deepEqual([v.reason, v.retryable], ['smtp_timeout', true]);
    } finally {
      await silent.stop();
    }
  });

  it('tries the backup MX when the primary answers 421', async () => {
    const backup = new FakeSmtpServer({ host: '127.0.0.1' });
    const p = await backup.start();
    const busy = new FakeSmtpServer({ host: '127.0.0.2', port: p, bannerCode: 421 });
    await busy.start();
    try {
      const r = await probeDomain('acme.test', ['127.0.0.2', '127.0.0.1'], ['alice'], opts(p));
      assert.equal(r.mxHost, '127.0.0.1');
      assert.equal(busy.stats.connections, 1);
      assert.equal(classifyOutcome(r.outcomes.get('alice')!).reason, 'accepted');
    } finally {
      await busy.stop();
      await backup.stop();
    }
  });
});

describe('InMemoryHostLimiter', () => {
  it('caps concurrency per host and hands slots over FIFO', async () => {
    const limiter = new InMemoryHostLimiter(2, 5000);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const release = await limiter.acquire('mx.test');
        assert.ok(release);
        active++;
        peak = Math.max(peak, active);
        order.push(i);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        await release();
      }),
    );
    assert.equal(peak, 2);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  });

  it('gives up after maxWaitMs and does not leak a slot', async () => {
    const limiter = new InMemoryHostLimiter(1, 30);
    const held = await limiter.acquire('mx.test');
    assert.equal(await limiter.acquire('mx.test'), null);
    await held!();
    await held!(); // double release is a no-op
    const again = await limiter.acquire('mx.test');
    assert.ok(again);
    assert.equal(await limiter.acquire('mx.test'), null);
  });

  it('keeps hosts independent', async () => {
    const limiter = new InMemoryHostLimiter(1, 10);
    assert.ok(await limiter.acquire('a.test'));
    assert.ok(await limiter.acquire('b.test'));
  });
});

describe('classifyRcptReply', () => {
  const cases: Array<[number, string | null, string, string, boolean]> = [
    [250, '2.1.5', 'ok', 'accepted', false],
    [550, '5.1.1', 'user unknown', 'mailbox_not_found', false],
    [550, null, 'No such user here', 'mailbox_not_found', false],
    [550, null, 'Requested action not taken', 'mailbox_not_found', false],
    [550, '5.7.1', 'Recipient address rejected: Access denied', 'smtp_blocked', false],
    [554, null, 'Service unavailable; client host blocked using Spamhaus', 'smtp_blocked', false],
    [552, '5.2.2', 'mailbox full', 'mailbox_full', false],
    [452, '4.2.2', 'over quota', 'mailbox_full', false],
    [452, '4.5.3', 'too many recipients', 'throttled', true],
    [451, '4.7.1', 'greylisted', 'greylisted', true],
    [450, null, 'try later', 'greylisted', true],
    [553, null, 'mailbox name not allowed', 'mailbox_not_found', false],
    [501, '5.5.4', 'syntax error in parameters', 'rejected', false],
  ];
  for (const [code, enhanced, message, reason, retryable] of cases) {
    it(`${code} ${enhanced ?? ''} "${message}" -> ${reason}`, () => {
      const v = classifyRcptReply({ code, enhanced, message });
      assert.deepEqual([v.reason, v.retryable], [reason, retryable]);
    });
  }
});
