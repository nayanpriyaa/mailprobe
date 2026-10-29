import type { VerificationResult, VerificationStatus } from '@mailprobe/core';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from '../db.js';
import { withTransaction } from '../db.js';
import type { IngestRow } from '../ingest.js';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface JobRow {
  id: number;
  public_id: string;
  account_id: number;
  name: string | null;
  status: JobStatus;
  total: number;
  processed: number;
  deliverable: number;
  undeliverable: number;
  risky: number;
  unknown: number;
  duplicates_removed: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

export interface VerificationRow {
  id: number;
  job_id: number | null;
  email: string;
  domain: string | null;
  state: 'pending' | 'retry' | 'done';
  status: VerificationStatus | null;
  reason: string | null;
  score: number | null;
  attempts: number;
  is_disposable: number;
  is_role: number;
  is_free: number;
  is_catch_all: number | null;
  mx_host: string | null;
  smtp_code: number | null;
  smtp_message: string | null;
  suggestion: string | null;
  created_at: Date;
  verified_at: Date | null;
}

const JOB_COLUMNS =
  'id, public_id, account_id, name, status, total, processed, deliverable, undeliverable, risky, unknown, duplicates_removed, created_at, started_at, completed_at, updated_at';

export const RESULT_COLUMNS =
  'id, job_id, email, domain, state, status, reason, score, attempts, is_disposable, is_role, is_free, is_catch_all, mx_host, smtp_code, smtp_message, suggestion, created_at, verified_at';

const INSERT_BATCH = 1000;

/**
 * Inserts the job and its pending rows. Runs inside the caller's transaction so the
 * credit debit, the job and its rows commit or roll back together.
 * Returns the job id and the inserted row ids in id order (for chunking).
 */
export async function insertJobWithRows(
  conn: PoolConnection,
  input: { publicId: string; accountId: number; name: string | null; rows: IngestRow[]; duplicatesRemoved: number },
): Promise<{ jobId: number; rowIds: number[] }> {
  const [res] = await conn.execute<ResultSetHeader>(
    'INSERT INTO jobs (public_id, account_id, name, total, duplicates_removed) VALUES (?, ?, ?, ?, ?)',
    [input.publicId, input.accountId, input.name, input.rows.length, input.duplicatesRemoved],
  );
  const jobId = res.insertId;

  // Multi-row INSERTs in batches: one round trip per 1000 rows instead of per row,
  // and each statement stays well under max_allowed_packet.
  for (let i = 0; i < input.rows.length; i += INSERT_BATCH) {
    const values = input.rows.slice(i, i + INSERT_BATCH).map((r) => [input.accountId, jobId, r.email, r.domain]);
    await conn.query('INSERT INTO verifications (account_id, job_id, email, domain) VALUES ?', [values]);
  }

  // Auto-increment ids are not guaranteed contiguous (innodb_autoinc_lock_mode=2),
  // so read them back rather than assuming insertId + n.
  const [ids] = await conn.query<RowDataPacket[]>('SELECT id FROM verifications WHERE job_id = ? ORDER BY id', [jobId]);
  return { jobId, rowIds: ids.map((r) => Number(r.id)) };
}

export async function getJobByPublicId(pool: Pool, accountId: number, publicId: string): Promise<JobRow | null> {
  const [rows] = await pool.execute<(JobRow & RowDataPacket)[]>(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE public_id = ? AND account_id = ?`,
    [publicId, accountId],
  );
  return rows[0] ?? null;
}

/** Newest first, keyset-paginated on id (uses ix_jobs_account_id). */
export async function listJobs(pool: Pool, accountId: number, beforeId: number | null, limit: number): Promise<JobRow[]> {
  const [rows] = await pool.query<(JobRow & RowDataPacket)[]>(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE account_id = ? ${beforeId !== null ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
    beforeId !== null ? [accountId, beforeId, limit] : [accountId, limit],
  );
  return rows;
}

/**
 * A page of a job's results in id order. With a status filter the query walks
 * ix_verifications_job_status_id; without one, ix_verifications_job_id. Either way
 * it reads exactly `limit` index entries, whatever the page number.
 */
export async function listResults(
  pool: Pool,
  jobId: number,
  opts: { status?: VerificationStatus | undefined; afterId: number | null; limit: number },
): Promise<VerificationRow[]> {
  const where = ['job_id = ?'];
  const params: unknown[] = [jobId];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.afterId !== null) {
    where.push('id > ?');
    params.push(opts.afterId);
  }
  params.push(opts.limit);
  const [rows] = await pool.query<(VerificationRow & RowDataPacket)[]>(
    `SELECT ${RESULT_COLUMNS} FROM verifications WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

export interface ChunkRow {
  id: number;
  account_id: number;
  email: string;
  attempts: number;
}

export async function loadChunk(pool: Pool, jobId: number, fromId: number, toId: number): Promise<ChunkRow[]> {
  const [rows] = await pool.query<(ChunkRow & RowDataPacket)[]>(
    `SELECT id, account_id, email, attempts FROM verifications
      WHERE job_id = ? AND id BETWEEN ? AND ? AND state IN ('pending', 'retry')
      ORDER BY id`,
    [jobId, fromId, toId],
  );
  return rows;
}

export async function markJobStarted(pool: Pool, jobId: number): Promise<void> {
  await pool.execute(
    "UPDATE jobs SET status = 'processing', started_at = COALESCE(started_at, NOW(3)) WHERE id = ? AND status = 'queued'",
    [jobId],
  );
}

export interface ChunkOutcome {
  row: ChunkRow;
  result: VerificationResult;
  /** true: settle as done; false: park as retry until `retryAt`. */
  final: boolean;
  retryAt: Date | null;
}

export interface ApplyResult {
  /** Rows this call actually moved; 0 if another worker got there first. */
  applied: number;
  finalized: number;
  retried: number[];
  jobCompleted: boolean;
}

const toFlag = (b: boolean | null) => (b === null ? null : b ? 1 : 0);

/**
 * Persists a chunk's verdicts and bumps the job counters, exactly once per row.
 *
 * At-least-once delivery means two workers may process the same chunk (a stalled job
 * gets re-delivered while the first worker is still alive). Locking the rows with
 * SELECT ... FOR UPDATE and keeping only those not yet 'done' makes the second
 * writer a no-op, so counters never double-count. Lock order is always
 * verifications -> jobs -> usage_daily, which rules out deadlock cycles between workers.
 */
export async function applyChunkResults(pool: Pool, jobId: number, outcomes: ChunkOutcome[]): Promise<ApplyResult> {
  if (outcomes.length === 0) return { applied: 0, finalized: 0, retried: [], jobCompleted: false };

  return withTransaction(pool, async (conn) => {
    const [lockedRows] = await conn.query<RowDataPacket[]>(
      "SELECT id FROM verifications WHERE id IN (?) AND state <> 'done' FOR UPDATE",
      [outcomes.map((o) => o.row.id)],
    );
    const locked = new Set(lockedRows.map((r) => Number(r.id)));
    const mine = outcomes.filter((o) => locked.has(o.row.id));
    if (mine.length === 0) return { applied: 0, finalized: 0, retried: [], jobCompleted: false };

    const now = new Date();
    const values = mine.map(({ row, result: r, final, retryAt }) => [
      row.id,
      row.account_id,
      jobId,
      row.email,
      r.domain,
      final ? 'done' : 'retry',
      final ? r.status : null,
      r.reason,
      final ? r.score : null,
      row.attempts + 1,
      toFlag(r.disposable),
      toFlag(r.role),
      toFlag(r.free),
      toFlag(r.catchAll),
      r.mxHost,
      r.smtpCode,
      r.smtpMessage,
      r.suggestion,
      final ? now : null,
      final ? null : retryAt,
    ]);
    // One statement updates every row: the upsert hits the primary key of rows we hold locks on.
    await conn.query(
      `INSERT INTO verifications
         (id, account_id, job_id, email, domain, state, status, reason, score, attempts,
          is_disposable, is_role, is_free, is_catch_all, mx_host, smtp_code, smtp_message, suggestion, verified_at, retry_at)
       VALUES ? AS new
       ON DUPLICATE KEY UPDATE
         domain = new.domain, state = new.state, status = new.status, reason = new.reason, score = new.score,
         attempts = new.attempts, is_disposable = new.is_disposable, is_role = new.is_role, is_free = new.is_free,
         is_catch_all = new.is_catch_all, mx_host = new.mx_host, smtp_code = new.smtp_code,
         smtp_message = new.smtp_message, suggestion = new.suggestion, verified_at = new.verified_at,
         retry_at = new.retry_at`,
      [values],
    );

    const finals = mine.filter((o) => o.final);
    const count = (s: VerificationStatus) => finals.filter((o) => o.result.status === s).length;
    let jobCompleted = false;
    if (finals.length > 0) {
      // MySQL evaluates single-table UPDATE assignments left to right, so `status` and
      // `completed_at` below already see the incremented `processed`.
      await conn.execute(
        `UPDATE jobs SET
           processed = processed + ?,
           deliverable = deliverable + ?, undeliverable = undeliverable + ?, risky = risky + ?, unknown = unknown + ?,
           status = IF(processed >= total, 'completed', 'processing'),
           completed_at = IF(processed >= total AND completed_at IS NULL, NOW(3), completed_at)
         WHERE id = ?`,
        [finals.length, count('deliverable'), count('undeliverable'), count('risky'), count('unknown'), jobId],
      );
      const [[job]] = await conn.query<RowDataPacket[]>('SELECT status, account_id FROM jobs WHERE id = ?', [jobId]);
      jobCompleted = job?.status === 'completed';
      await recordUsage(conn, Number(job!.account_id), finals.length, count('deliverable'));
    }

    return {
      applied: mine.length,
      finalized: finals.length,
      retried: mine.filter((o) => !o.final).map((o) => o.row.id),
      jobCompleted,
    };
  });
}

export async function recordUsage(
  conn: Pool | PoolConnection,
  accountId: number,
  verifications: number,
  deliverable: number,
): Promise<void> {
  await conn.execute(
    `INSERT INTO usage_daily (account_id, day, verifications, deliverable) VALUES (?, UTC_DATE(), ?, ?) AS new
     ON DUPLICATE KEY UPDATE verifications = usage_daily.verifications + new.verifications,
                             deliverable = usage_daily.deliverable + new.deliverable`,
    [accountId, verifications, deliverable],
  );
}

/** Single synchronous verification (no job): stored for history and usage. */
export async function insertSingleVerification(
  conn: Pool | PoolConnection,
  accountId: number,
  r: VerificationResult,
): Promise<number> {
  const [res] = await conn.execute<ResultSetHeader>(
    `INSERT INTO verifications
       (account_id, job_id, email, domain, state, status, reason, score, attempts, is_disposable, is_role, is_free,
        is_catch_all, mx_host, smtp_code, smtp_message, suggestion, verified_at)
     VALUES (?, NULL, ?, ?, 'done', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
    [
      accountId,
      (r.email ?? r.input.trim()).slice(0, 320),
      r.domain,
      r.status,
      r.reason,
      r.score,
      toFlag(r.disposable),
      toFlag(r.role),
      toFlag(r.free),
      toFlag(r.catchAll),
      r.mxHost,
      r.smtpCode,
      r.smtpMessage,
      r.suggestion,
    ],
  );
  return res.insertId;
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export async function findStalledJobs(pool: Pool, idleSeconds: number, limit = 50): Promise<Array<Pick<JobRow, 'id' | 'public_id'>>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, public_id FROM jobs
      WHERE status IN ('queued', 'processing') AND updated_at < NOW(3) - INTERVAL ? SECOND
      ORDER BY updated_at LIMIT ?`,
    [idleSeconds, limit],
  );
  return rows.map((r) => ({ id: Number(r.id), public_id: String(r.public_id) }));
}

/** Unfinished rows that should already be in flight: pending, or retry rows past due. */
export async function findRecoverableRows(
  pool: Pool,
  jobId: number,
  graceSeconds: number,
): Promise<Array<{ id: number; attempts: number }>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, attempts FROM verifications
      WHERE job_id = ? AND (state = 'pending' OR (state = 'retry' AND retry_at < NOW(3) - INTERVAL ? SECOND))
      ORDER BY id`,
    [jobId, graceSeconds],
  );
  return rows.map((r) => ({ id: Number(r.id), attempts: Number(r.attempts) }));
}

/** Touches a job so the reconciler does not pick it again immediately. */
export async function touchJob(pool: Pool, jobId: number): Promise<void> {
  await pool.execute('UPDATE jobs SET updated_at = NOW(3) WHERE id = ?', [jobId]);
}
