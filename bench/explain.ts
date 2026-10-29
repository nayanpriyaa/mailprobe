/**
 * Seeds one large job and compares query plans/timings for the access patterns the
 * API uses. Produces the numbers for docs/DB-OPTIMIZATION.md.
 *
 *   DATABASE_URL=mysql://root:root@127.0.0.1:3306/mailprobe npx tsx --conditions=development bench/explain.ts [rows]
 *
 * Uses EXPLAIN ANALYZE (MySQL 8.0.18+), which executes the query and reports actual
 * rows read and time per plan step.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';

const ROWS = Number(process.argv[2] ?? 200_000);
const url = process.env.DATABASE_URL ?? 'mysql://mailprobe:mailprobe@127.0.0.1:3306/mailprobe';
const db = await mysql.createConnection({ uri: url, multipleStatements: true });

console.log(`seeding ${ROWS} rows…`);
await db.query("INSERT INTO accounts (email, credits) VALUES ('explain@bench.test', 0) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)");
const [[{ id: accountId }]] = await db.query<RowDataPacket[]>('SELECT LAST_INSERT_ID() AS id');
await db.query(
  `INSERT INTO jobs (public_id, account_id, name, status, total, processed) VALUES (?, ?, 'explain', 'completed', ?, ?)`,
  [`EXPLAIN${Date.now()}`.padEnd(26, '0').slice(0, 26), accountId, ROWS, ROWS],
);
const [[{ id: jobId }]] = await db.query<RowDataPacket[]>('SELECT LAST_INSERT_ID() AS id');

// Generate rows server-side in batches; ~73% deliverable like the demo distribution.
const BATCH = 50_000;
await db.query('SET SESSION cte_max_recursion_depth = 1000000');
for (let start = 0; start < ROWS; start += BATCH) {
  const n = Math.min(BATCH, ROWS - start);
  await db.query(
    `INSERT INTO verifications (account_id, job_id, email, domain, state, status, reason, score, attempts, verified_at)
     WITH RECURSIVE seq (n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ? - 1)
     SELECT ?, ?, CONCAT('user', ? + n, '@company', (? + n) % 500, '.test'), CONCAT('company', (? + n) % 500, '.test'), 'done',
            ELT(1 + ((? + n) * 7919 % 100 >= 73) + ((? + n) * 7919 % 100 >= 85) + ((? + n) * 7919 % 100 >= 98),
                'deliverable', 'undeliverable', 'risky', 'unknown'),
            'accepted', 95, 1, NOW(3) - INTERVAL ((? + n) % 30) DAY
       FROM seq`,
    [n, accountId, jobId, start, start, start, start, start, start, start],
  );
  process.stdout.write('.');
}
await db.query('ANALYZE TABLE verifications');
console.log('\nseeded');

const [[mid]] = await db.query<RowDataPacket[]>(
  'SELECT id FROM verifications WHERE job_id = ? ORDER BY id LIMIT 1 OFFSET ?',
  [jobId, Math.floor(ROWS * 0.75)],
);
const offset = Math.floor(ROWS * 0.75);

const cases: Array<{ name: string; sql: string; params: unknown[] }> = [
  {
    name: `Results page at row ${offset}, OFFSET pagination`,
    sql: `SELECT id, email, status FROM verifications WHERE job_id = ? ORDER BY id LIMIT 100 OFFSET ${offset}`,
    params: [jobId],
  },
  {
    name: `Results page at row ${offset}, keyset pagination (what the API does)`,
    sql: 'SELECT id, email, status FROM verifications WHERE job_id = ? AND id > ? ORDER BY id LIMIT 100',
    params: [jobId, mid!.id],
  },
  {
    name: "Filter status='unknown' (rare), forced to the (job_id, id) index only",
    sql: "SELECT id, email FROM verifications FORCE INDEX (ix_verifications_job_id) WHERE job_id = ? AND status = 'unknown' ORDER BY id LIMIT 100",
    params: [jobId],
  },
  {
    name: "Filter status='unknown' (rare), with the (job_id, status, id) index",
    sql: "SELECT id, email FROM verifications WHERE job_id = ? AND status = 'unknown' ORDER BY id LIMIT 100",
    params: [jobId],
  },
  {
    name: 'Usage chart, aggregated from verifications',
    sql: `SELECT DATE(verified_at) AS day, COUNT(*) FROM verifications
           WHERE account_id = ? AND created_at > NOW() - INTERVAL 30 DAY GROUP BY day`,
    params: [accountId],
  },
  {
    name: 'Usage chart, from the usage_daily rollup (what the API does)',
    sql: 'SELECT day, verifications FROM usage_daily WHERE account_id = ? AND day > UTC_DATE() - INTERVAL 30 DAY',
    params: [accountId],
  },
];

let md = `# EXPLAIN ANALYZE results\n\n${ROWS.toLocaleString('en')} rows in one job, MySQL ${(await db.query<RowDataPacket[]>('SELECT VERSION() AS v'))[0][0]!.v}.\n\n`;
md += '| Query | Median time (ms) | Rows examined (top step) |\n|---|---:|---:|\n';
const plans: string[] = [];
for (const c of cases) {
  const times: number[] = [];
  let plan = '';
  for (let i = 0; i < 5; i++) {
    const [rows] = await db.query<RowDataPacket[]>(`EXPLAIN ANALYZE ${c.sql}`, c.params);
    plan = String(Object.values(rows[0]!)[0]);
    const t = /actual time=[\d.]+\.\.([\d.]+)/.exec(plan);
    times.push(t ? Number(t[1]) : NaN);
  }
  times.sort((a, b) => a - b);
  const examined = [...plan.matchAll(/rows=(\d+)/g)].map((m) => Number(m[1]));
  md += `| ${c.name} | ${times[2]!.toFixed(2)} | ${Math.max(...examined).toLocaleString('en')} |\n`;
  plans.push(`### ${c.name}\n\n\`\`\`\n${plan.trim()}\n\`\`\`\n`);
  console.log(`${c.name}: ${times[2]!.toFixed(2)} ms`);
}
md += `\n## Plans\n\n${plans.join('\n')}`;

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const out = new URL(`./results/explain-${Date.now()}.md`, import.meta.url);
writeFileSync(out, md);
console.log(`wrote ${out.pathname}`);

await db.query('DELETE FROM jobs WHERE id = ?', [jobId]); // cascades to verifications
await db.end();
