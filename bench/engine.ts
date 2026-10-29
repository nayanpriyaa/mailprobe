/**
 * Engine benchmark: how much does grouping by domain save?
 *
 * Runs the same address list through the verifier two ways against the fake SMTP
 * server with injected per-reply latency:
 *   naive    - one verifyBatch call per address (one SMTP session per address)
 *   batched  - domain-sorted chunks of CHUNK addresses (what the worker does)
 *
 * Both use the same total concurrency and the same per-MX connection cap, so the
 * difference is purely the session strategy.
 *
 *   npx tsx --conditions=development bench/engine.ts [addresses] [domains] [latencyMs]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { FakeSmtpServer } from '@mailprobe/fake-smtp';
import {
  DEFAULT_PROBE_OPTIONS,
  DomainSet,
  InMemoryCache,
  InMemoryHostLimiter,
  StaticMxResolver,
  Verifier,
  mapLimit,
  type MxLookup,
} from '@mailprobe/core';

const N = Number(process.argv[2] ?? 5000);
const DOMAINS = Number(process.argv[3] ?? 250);
const LATENCY = Number(process.argv[4] ?? 40);
const CHUNK = 50;
const CONCURRENCY = 16; // in-flight units of work (addresses for naive, chunks for batched)
const PER_HOST = 3;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

// Zipf-ish domain popularity: a few big companies, a long tail. Realistic for B2B lists.
function makeList(n: number, domains: number): string[] {
  const r = rng(42);
  const weights = Array.from({ length: domains }, (_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const pick = () => {
    let x = r() * total;
    for (let i = 0; i < domains; i++) if ((x -= weights[i]!) <= 0) return i;
    return domains - 1;
  };
  const out = new Set<string>();
  while (out.size < n) {
    const d = pick();
    const u = Math.floor(r() * 1e6);
    const prefix = u % 50 === 0 ? 'bounce' : u % 97 === 0 ? 'grey' : 'user';
    out.add(`${prefix}${u}@company${d}.test`);
  }
  return [...out];
}

async function run(mode: 'naive' | 'batched', list: string[], port: number, server: FakeSmtpServer) {
  const fixtures: Record<string, MxLookup> = {};
  for (let d = 0; d < DOMAINS; d++) {
    fixtures[`company${d}.test`] = { kind: 'mx', implicit: false, hosts: [{ exchange: `mx${d % 40}.provider.test`, priority: 10 }] };
  }
  const verifier = new Verifier(
    {
      resolver: new StaticMxResolver(fixtures),
      cache: new InMemoryCache(),
      limiter: new InMemoryHostLimiter(PER_HOST, 120_000),
      disposable: new DomainSet([]),
    },
    {
      domainConcurrency: 4,
      smtp: {
        ...DEFAULT_PROBE_OPTIONS,
        heloName: 'bench.test',
        mailFrom: 'bench@bench.test',
        port,
        // Every probe goes to the fake server; the limiter still keys on the real MX
        // name, so 40 "providers" hosting 250 domains are each capped at PER_HOST.
        hostOverride: '127.0.0.1',
        connectTimeoutMs: 5000,
        commandTimeoutMs: 5000,
      },
    },
  );

  const before = { ...server.stats };
  const started = performance.now();
  let results;
  if (mode === 'naive') {
    results = await mapLimit(list, CONCURRENCY, (e) => verifier.verify(e));
  } else {
    const sorted = [...list].sort((a, b) => a.split('@')[1]!.localeCompare(b.split('@')[1]!));
    const chunks: string[][] = [];
    for (let i = 0; i < sorted.length; i += CHUNK) chunks.push(sorted.slice(i, i + CHUNK));
    results = (await mapLimit(chunks, CONCURRENCY, (c) => verifier.verifyBatch(c))).flat();
  }
  const seconds = (performance.now() - started) / 1000;
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    mode,
    addresses: list.length,
    seconds: Number(seconds.toFixed(2)),
    perMinute: Math.round((list.length / seconds) * 60),
    smtpSessions: server.stats.connections - before.connections,
    rcptCommands: server.stats.rcptCommands - before.rcptCommands,
    dnsLookups: verifier.metrics.dnsLookups,
    mxCacheHits: verifier.metrics.mxCacheHits,
    peakConcurrentSessions: server.stats.maxConcurrentConnections,
    verdicts: counts,
  };
}

const list = makeList(N, DOMAINS);
const out = [];
for (const mode of ['naive', 'batched'] as const) {
  const server = new FakeSmtpServer({ latencyMs: [LATENCY * 0.5, LATENCY * 1.5], greylistTimes: 1_000_000 });
  const port = await server.start();
  out.push(await run(mode, list, port, server));
  await server.stop();
}

const [naive, batched] = out;
const summary = {
  config: { addresses: N, domains: DOMAINS, latencyMsPerReply: `${LATENCY * 0.5}-${LATENCY * 1.5}`, chunk: CHUNK, concurrency: CONCURRENCY, node: process.version },
  results: out,
  speedup: Number((batched!.perMinute / naive!.perMinute).toFixed(1)),
  sessionReduction: Number((naive!.smtpSessions / batched!.smtpSessions).toFixed(1)),
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./results/engine-${Date.now()}.json`, import.meta.url), JSON.stringify(summary, null, 2));
