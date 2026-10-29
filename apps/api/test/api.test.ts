/**
 * End-to-end tests against real MySQL and Redis (the CI workflow provides both as
 * service containers). Skipped when TEST_DATABASE_URL is not set.
 *
 *   TEST_DATABASE_URL=mysql://root:root@127.0.0.1:3306/mailprobe_test \
 *   TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test -w @mailprobe/api
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import mysql from 'mysql2/promise';
import { FakeSmtpServer } from '@mailprobe/fake-smtp';
import {
  VERIFY_QUEUE,
  createLogger,
  createPool,
  createRedis,
  createVerifier,
  createVerifyQueue,
  loadConfig,
  runMigrations,
  type ChunkPayload,
  type Config,
} from '@mailprobe/server';
import { processChunk } from '@mailprobe/worker';
import { buildApp } from '../src/app.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

describe('API end-to-end', { skip: !DB_URL && 'TEST_DATABASE_URL not set' }, () => {
  const smtp = new FakeSmtpServer({ catchAllDomains: ['catchall.test'], greylistTimes: 1 });
  let base = '';
  let cfg: Config;
  let teardown: Array<() => Promise<unknown>> = [];
  let deps: Parameters<typeof processChunk>[0];
  let apiRedis: ReturnType<typeof createRedis>;

  const call = async (path: string, init: RequestInit & { key?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.key) headers.set('authorization', `Bearer ${init.key}`);
    if (init.body && typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const res = await fetch(base + path, { ...init, headers });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // CSV or empty
    }
    return { status: res.status, headers: res.headers, body };
  };

  const signup = async (email: string) => {
    const r = await call('/v1/signup', { method: 'POST', body: JSON.stringify({ email }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.api_key as string;
  };

  const waitForJob = async (key: string, id: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await call(`/v1/jobs/${id}`, { key });
      if (r.body.status === 'completed') return r.body;
      if (Date.now() > deadline) throw new Error(`job ${id} did not complete: ${JSON.stringify(r.body)}`);
      await new Promise((res) => setTimeout(res, 100));
    }
  };

  before(async () => {
    // Fresh database per run.
    const url = new URL(DB_URL!);
    const dbName = url.pathname.slice(1);
    const admin = await mysql.createConnection({ uri: `${url.protocol}//${url.username}:${url.password}@${url.host}/` });
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`CREATE DATABASE \`${dbName}\``);
    await admin.end();
    await runMigrations(DB_URL!, fileURLToPath(new URL('../../../db/migrations', import.meta.url)), () => undefined);

    const smtpPort = await smtp.start();
    const dir = mkdtempSync(join(tmpdir(), 'mailprobe-test-'));
    const mx = (h: string) => ({ kind: 'mx', implicit: false, hosts: [{ exchange: h, priority: 10 }] });
    writeFileSync(
      join(dir, 'dns.json'),
      JSON.stringify({
        'acme.test': mx('mx.acme.test'),
        'catchall.test': mx('mx.catchall.test'),
        'gone.test': { kind: 'none' },
      }),
    );

    cfg = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: DB_URL,
      REDIS_URL,
      SIGNUP_CREDITS: '100',
      SIGNUP_LIMIT_PER_HOUR: '1000',
      DNS_MODE: 'fixtures',
      DNS_FIXTURES_PATH: join(dir, 'dns.json'),
      SMTP_PORT: String(smtpPort),
      SMTP_HOST_OVERRIDE: '127.0.0.1',
      SMTP_CONNECT_TIMEOUT_MS: '1000',
      SMTP_COMMAND_TIMEOUT_MS: '1000',
      CHUNK_SIZE: '4',
      MAX_ATTEMPTS: '2',
      RETRY_BASE_DELAY_MS: '200',
    });
    const logger = createLogger(cfg, 'test');
    const pool = createPool(cfg);
    const redis = createRedis(cfg);
    apiRedis = redis;
    await redis.flushdb();
    const queue = createVerifyQueue(redis);
    const verifier = createVerifier(cfg, redis);
    deps = { cfg, pool, queue, verifier, logger };

    const workerRedis = createRedis(cfg);
    const worker = new Worker<ChunkPayload>(VERIFY_QUEUE, (job) => processChunk(deps, job.data), {
      connection: workerRedis,
      concurrency: 4,
    });

    const server = buildApp({ cfg, pool, redis, queue, verifier, logger }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    teardown = [
      () => new Promise((r) => server.close(r)),
      () => worker.close(),
      () => queue.close(),
      () => workerRedis.quit(),
      () => redis.quit(),
      () => pool.end(),
      () => smtp.stop(),
    ];
  });

  after(async () => {
    for (const fn of teardown) await fn();
  });

  it('serves health and docs', async () => {
    assert.deepEqual((await call('/healthz')).body, { status: 'ok', mysql: 'up', redis: 'up' });
    assert.match((await call('/openapi.yaml')).body, /openapi: 3\.1/);
  });

  it('signs up once per email and returns a key', async () => {
    const key = await signup('owner@example.com');
    assert.match(key, /^mp_live_/);
    const dup = await call('/v1/signup', { method: 'POST', body: JSON.stringify({ email: 'OWNER@example.com' }) });
    assert.equal(dup.status, 409);
    const bad = await call('/v1/signup', { method: 'POST', body: JSON.stringify({ email: 'nope' }) });
    assert.equal(bad.status, 400);
  });

  it('rejects missing, malformed and unknown keys', async () => {
    assert.equal((await call('/v1/me')).status, 401);
    assert.equal((await call('/v1/me', { key: 'garbage' })).status, 401);
    assert.equal((await call('/v1/me', { key: `mp_live_${'a'.repeat(32)}` })).status, 401);
  });

  it('verifies a single address and charges one credit', async () => {
    const key = await signup('single@example.com');
    const r = await call('/v1/verify', { method: 'POST', key, body: JSON.stringify({ email: 'Alice@ACME.test' }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.email, 'alice@acme.test');
    assert.equal(r.body.status, 'deliverable');
    assert.equal((await call('/v1/me', { key })).body.credits, 99);

    const gone = await call('/v1/verify', { method: 'POST', key, body: JSON.stringify({ email: 'x@gone.test' }) });
    assert.deepEqual([gone.body.status, gone.body.reason], ['undeliverable', 'no_mx']);
  });

  it('runs a CSV job end to end, including a greylisting retry', async () => {
    const key = await signup('bulk@example.com');
    const csv = [
      'name,email',
      'A,alice@acme.test',
      'A again,ALICE@acme.test', // duplicate
      'B,bounce@acme.test',
      'C,grey@acme.test', // 451 first, accepted on retry
      'D,anyone@catchall.test',
      'E,x@gone.test',
      'F,not-an-email',
      'G,info@acme.test',
    ].join('\n');
    const created = await call('/v1/jobs?name=leads.csv', { method: 'POST', key, body: csv, headers: { 'content-type': 'text/csv' } });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(created.headers.get('location'), `/v1/jobs/${created.body.id}`);
    assert.equal(created.body.total, 7);
    assert.equal(created.body.duplicates_removed, 1);

    const job = await waitForJob(key, created.body.id);
    assert.equal(job.processed, 7);
    assert.deepEqual(job.counts, { deliverable: 3, undeliverable: 3, risky: 1, unknown: 0 });

    const all = await call(`/v1/jobs/${job.id}/results?limit=100`, { key });
    const byEmail = Object.fromEntries(all.body.data.map((r: any) => [r.email, r]));
    assert.equal(byEmail['grey@acme.test'].status, 'deliverable');
    assert.equal(byEmail['grey@acme.test'].attempts, 2);
    assert.equal(byEmail['anyone@catchall.test'].reason, 'catch_all');
    assert.equal(byEmail['not-an-email'].reason, 'invalid_syntax');
    assert.equal(byEmail['info@acme.test'].role, true);

    // Keyset pagination returns every row exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await call(`/v1/jobs/${job.id}/results?limit=2${cursor ? `&cursor=${cursor}` : ''}`, { key });
      seen.push(...page.body.data.map((r: any) => r.email));
      cursor = page.body.next_cursor;
    } while (cursor);
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);

    const deliverable = await call(`/v1/jobs/${job.id}/results?status=deliverable`, { key });
    assert.equal(deliverable.body.data.length, 3);

    const exported = await call(`/v1/jobs/${job.id}/export.csv?status=undeliverable`, { key });
    const lines = (exported.body as string).trim().split('\r\n');
    assert.equal(lines[0], 'email,status,reason,score,disposable,role,free,catch_all,mx_host,smtp_code,suggestion,verified_at');
    assert.equal(lines.length, 4);

    assert.equal((await call('/v1/me', { key })).body.credits, 93);
    const usage = await call('/v1/usage?days=7', { key });
    assert.equal(usage.body.data[0].verifications, 7);
  });

  it('refuses uploads larger than the credit balance without charging', async () => {
    const key = await signup('broke@example.com');
    const emails = Array.from({ length: 101 }, (_, i) => `user${i}@acme.test`);
    const r = await call('/v1/jobs', { method: 'POST', key, body: JSON.stringify({ emails }) });
    assert.equal(r.status, 402);
    assert.deepEqual(r.body.error.details, { needed: 101, available: 100 });
    assert.equal((await call('/v1/me', { key })).body.credits, 100);
    assert.equal((await call('/v1/jobs', { key })).body.data.length, 0);
  });

  it('counts each row once even if a chunk is processed twice concurrently', async () => {
    const key = await signup('dupes@example.com');
    // The shared worker picks this chunk up too, so up to three processors race on the same rows.
    const created = await call('/v1/jobs', {
      method: 'POST',
      key,
      body: JSON.stringify({ emails: ['p1@acme.test', 'p2@acme.test', 'p3@acme.test'] }),
    });
    const [results] = await deps.pool.query<any[]>(
      'SELECT j.id, MIN(v.id) AS lo, MAX(v.id) AS hi FROM jobs j JOIN verifications v ON v.job_id = j.id WHERE j.public_id = ? GROUP BY j.id',
      [created.body.id],
    );
    const payload: ChunkPayload = {
      jobId: Number(results[0].id),
      publicId: created.body.id,
      fromId: Number(results[0].lo),
      toId: Number(results[0].hi),
      attempt: 0,
    };
    await Promise.all([processChunk(deps, payload), processChunk(deps, payload)]);
    const job = await waitForJob(key, created.body.id);
    assert.equal(job.processed, 3);
    assert.equal(job.counts.deliverable, 3);
  });

  it('paginates jobs newest first', async () => {
    const key = await signup('lister@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call('/v1/jobs', { method: 'POST', key, body: JSON.stringify({ emails: [`u${i}@acme.test`] }) });
      ids.push(r.body.id);
    }
    const p1 = await call('/v1/jobs?limit=2', { key });
    assert.deepEqual(
      p1.body.data.map((j: any) => j.id),
      [ids[2], ids[1]],
    );
    const p2 = await call(`/v1/jobs?limit=2&cursor=${p1.body.next_cursor}`, { key });
    assert.deepEqual(
      p2.body.data.map((j: any) => j.id),
      [ids[0]],
    );
    assert.equal(p2.body.next_cursor, null);
    assert.equal((await call('/v1/jobs?cursor=bogus', { key })).status, 400);
  });

  it('manages API keys and refuses to revoke the last one', async () => {
    const key = await signup('keys@example.com');
    const list = await call('/v1/keys', { key });
    const firstId = list.body.data[0].id;
    assert.equal((await call(`/v1/keys/${firstId}`, { method: 'DELETE', key })).status, 409);

    const created = await call('/v1/keys', { method: 'POST', key, body: JSON.stringify({ name: 'CI' }) });
    assert.equal(created.status, 201);
    assert.equal((await call(`/v1/keys/${firstId}`, { method: 'DELETE', key: created.body.api_key })).status, 204);
    assert.equal((await call('/v1/me', { key })).status, 401);
    assert.equal((await call('/v1/me', { key: created.body.api_key })).status, 200);
  });

  it('rate-limits per key with a token bucket', async () => {
    const strictCfg = { ...cfg, RATE_LIMIT_BURST: 3, RATE_LIMIT_PER_SEC: 0.001 };
    const server = buildApp({ ...deps, cfg: strictCfg, redis: apiRedis }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const key = await signup('limited@example.com');
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await fetch(`${url}/v1/me`, { headers: { authorization: `Bearer ${key}` } })).status);
      }
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
