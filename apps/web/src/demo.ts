import type { Account, Api, ApiKey, Job, Page, ResultRow, Status, Verification } from './api';

/**
 * In-browser stand-in for the API so the dashboard can be explored without a
 * backend. Verdicts are simulated from simple rules; nothing is sent anywhere.
 */

const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'yopmail.com', 'tempmail.dev']);
const CATCH_ALL = new Set(['bigcorp.io', 'northwind.co']);
const ROLE = new Set(['info', 'sales', 'support', 'admin', 'hello', 'contact', 'team', 'billing']);
const FREE = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com']);
const TYPOS: Record<string, string> = { 'gmial.com': 'gmail.com', 'gmail.co': 'gmail.com', 'yaho.com': 'yahoo.com', 'outlok.com': 'outlook.com' };
const SCORE: Record<Status, number> = { deliverable: 95, undeliverable: 0, risky: 55, unknown: 30 };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function judge(input: string): Verification {
  const email = input.trim().toLowerCase();
  const m = /^([a-z0-9._%+'_-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(email);
  const base = { email, syntax_error: null, disposable: false, role: false, free: false, catch_all: null, mx_host: null, smtp_code: null, smtp_message: null, suggestion: null };
  if (!m) return { ...base, email: input.trim(), status: 'undeliverable', reason: 'invalid_syntax', score: 0, syntax_error: 'local_invalid' };
  const [, local, domain] = m as unknown as [string, string, string];
  const flags = { role: ROLE.has(local), free: FREE.has(domain), mx_host: `mx1.${domain}` };
  const out = (status: Status, reason: string, extra: Partial<Verification> = {}): Verification => ({
    ...base,
    ...flags,
    status,
    reason,
    // Same heuristic as the real engine (packages/core/src/classify.ts).
    score: Math.max(0, (reason === 'disposable' ? 10 : reason === 'mailbox_full' ? 35 : SCORE[status]) - (flags.role && status !== 'undeliverable' ? 15 : 0)),
    catch_all: false,
    ...extra,
  });

  if (TYPOS[domain]) return out('undeliverable', 'no_mx', { mx_host: null, catch_all: null, suggestion: TYPOS[domain]! });
  if (DISPOSABLE.has(domain)) return out('risky', 'disposable', { disposable: true, catch_all: null });
  if (CATCH_ALL.has(domain)) return out('risky', 'catch_all', { catch_all: true, smtp_code: 250 });
  if (/^(bounce|old|former)/.test(local)) return out('undeliverable', 'mailbox_not_found', { smtp_code: 550 });
  const roll = hash(email) % 100;
  if (roll < 86) return out('deliverable', 'accepted', { smtp_code: 250 });
  if (roll < 95) return out('undeliverable', 'mailbox_not_found', { smtp_code: 550 });
  if (roll < 97) return out('risky', 'mailbox_full', { smtp_code: 552 });
  return out('unknown', 'smtp_timeout', { smtp_code: null });
}

const FIRST = ['ana', 'ben', 'chen', 'dev', 'elena', 'farah', 'gus', 'hiro', 'isha', 'jon', 'kavya', 'leo', 'maya', 'nikhil', 'olu', 'priya', 'quinn', 'rahul', 'sara', 'tomas'];
const LAST = ['shah', 'kim', 'rossi', 'nair', 'okafor', 'lund', 'mehta', 'garcia', 'iyer', 'park'];
// Weighted: mostly company domains, a few catch-alls, the odd typo and throwaway inbox.
const DOMAINS = [
  ...Array(6).fill('acme.com'), ...Array(5).fill('globex.io'), ...Array(5).fill('initech.com'), ...Array(4).fill('umbrella.co'),
  ...Array(4).fill('hooli.dev'), ...Array(4).fill('gmail.com'), ...Array(3).fill('stark.industries'), ...Array(3).fill('wayne.co'),
  ...Array(2).fill('bigcorp.io'), 'northwind.co', 'gmial.com', 'mailinator.com',
];

function sampleList(n: number, seed: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = hash(`${seed}:${i}`);
    const first = FIRST[h % 20]!;
    const last = LAST[(h >>> 5) % 10]!;
    const style = (h >>> 13) % 4;
    const person = style === 0 ? `${first}.${last}` : style === 1 ? `${first}${last[0]}` : style === 2 ? `${first[0]}${last}` : `${first}_${last}${(h >>> 17) % 90}`;
    const local = i % 41 === 0 ? 'sales' : i % 31 === 0 ? `old.${last}` : person;
    out.push(`${local}@${DOMAINS[(h >>> 9) % DOMAINS.length]}`);
  }
  return out;
}

interface DemoJob {
  job: Job;
  rows: ResultRow[];
  /** Simulated throughput, rows per second. */
  rate: number;
  startedAt: number;
  verdicts: Verification[];
}

function toRow(v: Verification, done: boolean): ResultRow {
  return done
    ? { ...v, state: 'done', attempts: 1, verified_at: new Date().toISOString() }
    : { ...v, state: 'pending', status: null, reason: null, score: null, attempts: 0, verified_at: null, mx_host: null, smtp_code: null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function demoApi(): Api {
  const account: Account = { email: 'demo@mailprobe.dev', name: 'Demo', credits: 4210, created_at: new Date(Date.now() - 86400e3 * 12).toISOString() };
  const keys: ApiKey[] = [
    { id: 1, name: 'Default', prefix: 'mp_live_D3mo', last_used_at: new Date().toISOString(), revoked_at: null, created_at: account.created_at, current: true },
  ];
  const jobs: DemoJob[] = [];
  let seq = 0;

  const ulidish = () => `01JDEMO${String(++seq).padStart(4, '0')}${Math.random().toString(36).slice(2, 17).toUpperCase().padEnd(15, 'X')}`.slice(0, 26);

  const addJob = (name: string, emails: string[], rate: number, ageMs = 0) => {
    const seen = new Set<string>();
    const unique = emails.map((e) => e.trim()).filter((e) => e && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
    const verdicts = unique.map(judge);
    const created = new Date(Date.now() - ageMs).toISOString();
    const d: DemoJob = {
      job: {
        id: ulidish(),
        name,
        status: 'queued',
        total: unique.length,
        processed: 0,
        progress: 0,
        counts: { deliverable: 0, undeliverable: 0, risky: 0, unknown: 0 },
        duplicates_removed: emails.length - unique.length,
        created_at: created,
        started_at: null,
        completed_at: null,
      },
      rows: verdicts.map((v) => toRow(v, false)),
      rate,
      startedAt: Date.now() - ageMs,
      verdicts,
    };
    jobs.unshift(d);
    return d;
  };

  // Advance a job to where it would be by now.
  const tick = (d: DemoJob) => {
    const { verdicts } = d;
    const target = Math.min(d.job.total, Math.floor(((Date.now() - d.startedAt) / 1000) * d.rate));
    for (let i = d.job.processed; i < target; i++) {
      d.rows[i] = toRow(verdicts[i]!, true);
      d.job.counts[verdicts[i]!.status]++;
    }
    d.job.processed = target;
    d.job.progress = d.job.total ? target / d.job.total : 1;
    if (target > 0 && !d.job.started_at) d.job.started_at = new Date(d.startedAt + 400).toISOString();
    d.job.status = target >= d.job.total ? 'completed' : target > 0 ? 'processing' : 'queued';
    if (d.job.status === 'completed' && !d.job.completed_at) {
      d.job.completed_at = new Date(d.startedAt + 400 + (d.job.total / d.rate) * 1000).toISOString();
    }
    return d;
  };

  addJob('webinar-signups-oct.csv', sampleList(420, 1), 35, 86400e3 * 3);
  addJob('q4-outbound-saas-founders.csv', [...sampleList(1800, 2), ...sampleList(40, 2)], 48, 86400e3);

  const find = (id: string) => {
    const d = jobs.find((j) => j.job.id === id);
    if (!d) throw new Error('Job not found');
    return tick(d);
  };

  return {
    demo: true,
    me: async () => ({ ...account }),
    verify: async (email) => {
      await sleep(600);
      account.credits--;
      return judge(email);
    },
    createJobFromCsv: async (csv, name) => {
      await sleep(300);
      const emails = csv
        .split(/\r?\n/)
        .flatMap((line) => line.split(','))
        .map((c) => c.replace(/^"|"$/g, '').trim())
        .filter((c) => c.includes('@'));
      const list = emails.length > 0 ? emails : sampleList(600, Date.now());
      const d = addJob(name || 'upload.csv', list, Math.max(20, list.length / 12));
      account.credits -= d.job.total;
      return { ...tick(d).job };
    },
    listJobs: async (): Promise<Page<Job>> => ({ data: jobs.map((d) => ({ ...tick(d).job, counts: { ...d.job.counts } })), next_cursor: null }),
    getJob: async (id) => {
      const j = find(id).job;
      return { ...j, counts: { ...j.counts } };
    },
    results: async (id, { status, cursor }) => {
      const rows = find(id).rows.filter((r) => !status || r.status === status);
      const start = cursor ? Number(cursor) : 0;
      const page = rows.slice(start, start + 100);
      return { data: page, next_cursor: start + 100 < rows.length ? String(start + 100) : null };
    },
    exportUrl: async (id, status) => {
      const header = 'email,status,reason,score\r\n';
      const body = find(id)
        .rows.filter((r) => r.state === 'done' && (!status || r.status === status))
        .map((r) => `${r.email},${r.status},${r.reason},${r.score}\r\n`)
        .join('');
      return URL.createObjectURL(new Blob([header + body], { type: 'text/csv' }));
    },
    listKeys: async () => keys.map((k) => ({ ...k })),
    createKey: async (name) => {
      const k = `mp_live_${Array.from({ length: 32 }, () => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 56)]).join('')}`;
      keys.push({ id: keys.length + 1, name, prefix: k.slice(0, 12), last_used_at: null, revoked_at: null, created_at: new Date().toISOString(), current: false });
      return { api_key: k };
    },
    revokeKey: async (id) => {
      const active = keys.filter((k) => !k.revoked_at);
      if (active.length === 1) throw new Error('Create another key before revoking your last one.');
      const k = keys.find((x) => x.id === id);
      if (k) k.revoked_at = new Date().toISOString();
    },
  };
}

