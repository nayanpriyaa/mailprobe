/**
 * End-to-end throughput through the real stack: API -> MySQL -> BullMQ -> worker(s)
 * -> fake SMTP (with latency) -> MySQL. Run against `docker compose --profile demo up`.
 *
 *   API_URL=http://localhost:4000 npx tsx bench/pipeline.ts [addresses] [domains]
 *
 * Scale workers with `docker compose --profile demo up --scale worker=4` and rerun
 * to see how throughput changes.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const N = Number(process.argv[2] ?? 10_000);
const DOMAINS = Number(process.argv[3] ?? 250);

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(API + path, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const { api_key: key } = await call('/v1/signup', {
  method: 'POST',
  body: JSON.stringify({ email: `bench-${Date.now()}@bench.test` }),
});
const auth = { authorization: `Bearer ${key}` };

const emails = Array.from({ length: N }, (_, i) => `user${i}@company${i % DOMAINS}.test`);
const uploadStarted = performance.now();
const job = await call('/v1/jobs', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'bench', emails }) });
const uploadMs = performance.now() - uploadStarted;
console.log(`upload accepted in ${uploadMs.toFixed(0)} ms (job ${job.id})`);

for (;;) {
  const j = await call(`/v1/jobs/${job.id}`, { headers: auth });
  process.stdout.write(`\r${j.processed}/${j.total}`);
  if (j.status === 'completed') {
    const seconds = (new Date(j.completed_at).getTime() - new Date(j.created_at).getTime()) / 1000;
    console.log(`\n${N} addresses in ${seconds.toFixed(1)} s = ${Math.round((N / seconds) * 60)} / min`);
    console.log(JSON.stringify(j.counts));
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
