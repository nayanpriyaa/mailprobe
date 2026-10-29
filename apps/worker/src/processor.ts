import type { Verifier } from '@mailprobe/core';
import {
  chunkIdRanges,
  enqueueChunks,
  jobsRepo,
  type ChunkPayload,
  type Config,
  type Logger,
  type Pool,
} from '@mailprobe/server';
import type { Queue } from 'bullmq';

export interface ProcessorDeps {
  cfg: Pick<Config, 'MAX_ATTEMPTS' | 'RETRY_BASE_DELAY_MS' | 'CHUNK_SIZE'>;
  pool: Pool;
  queue: Queue<ChunkPayload>;
  verifier: Verifier;
  logger: Logger;
}

export interface ChunkReport {
  loaded: number;
  applied: number;
  finalized: number;
  retried: number;
  jobCompleted: boolean;
}

/** Exponential backoff for mail-level retries: base, 2x base, 4x base, ... */
export const retryDelayMs = (base: number, attempt: number) => base * 2 ** attempt;

/**
 * Processes one chunk: load unfinished rows -> verify -> persist verdicts.
 *
 * Retryable verdicts (greylisting, timeouts, throttling) are parked in state 'retry'
 * and re-enqueued as one delayed chunk; on the last attempt they settle as final.
 * Every step is safe to repeat, so BullMQ redelivery or a reconciler re-enqueue
 * cannot double-count or double-charge.
 */
export async function processChunk(deps: ProcessorDeps, p: ChunkPayload): Promise<ChunkReport> {
  const { cfg, pool, queue, verifier, logger } = deps;
  const rows = await jobsRepo.loadChunk(pool, p.jobId, p.fromId, p.toId);
  if (rows.length === 0) return { loaded: 0, applied: 0, finalized: 0, retried: 0, jobCompleted: false };

  await jobsRepo.markJobStarted(pool, p.jobId);
  const results = await verifier.verifyBatch(rows.map((r) => r.email));

  const nextAttempt = p.attempt + 1;
  const retryAt = new Date(Date.now() + retryDelayMs(cfg.RETRY_BASE_DELAY_MS, p.attempt));
  const outcomes = rows.map((row, i) => {
    const result = results[i]!;
    // attempts counts completed passes for this row; settle once the budget is spent.
    const final = !result.retryable || row.attempts + 1 >= cfg.MAX_ATTEMPTS;
    return { row, result, final, retryAt: final ? null : retryAt };
  });

  const applied = await jobsRepo.applyChunkResults(pool, p.jobId, outcomes);

  if (applied.retried.length > 0) {
    // Retry rows keep their original id range; one delayed chunk covers them all.
    await enqueueChunks(
      queue,
      { id: p.jobId, publicId: p.publicId },
      chunkIdRanges(applied.retried, cfg.CHUNK_SIZE),
      nextAttempt,
      retryAt.getTime() - Date.now(),
    );
  }

  if (applied.jobCompleted) logger.info({ job: p.publicId }, 'job completed');
  return {
    loaded: rows.length,
    applied: applied.applied,
    finalized: applied.finalized,
    retried: applied.retried.length,
    jobCompleted: applied.jobCompleted,
  };
}

/**
 * Safety net for the gap between "rows committed" and "chunk enqueued" (API crash,
 * Redis blip) and for delayed retry jobs lost with a Redis flush. Finds jobs with no
 * progress for a while and re-enqueues their unfinished rows. Enqueue is idempotent
 * by job id and row processing is idempotent by state, so false positives are cheap.
 */
export async function reconcile(
  deps: Pick<ProcessorDeps, 'pool' | 'queue' | 'logger' | 'cfg'>,
  idleSeconds: number,
): Promise<number> {
  const { pool, queue, logger, cfg } = deps;
  const stalled = await jobsRepo.findStalledJobs(pool, idleSeconds);
  let requeued = 0;
  for (const job of stalled) {
    const rows = await jobsRepo.findRecoverableRows(pool, job.id, idleSeconds);
    if (rows.length === 0) continue;
    // Group by attempt so each re-enqueued chunk carries the right attempt number.
    const byAttempt = new Map<number, number[]>();
    for (const r of rows) byAttempt.set(r.attempts, [...(byAttempt.get(r.attempts) ?? []), r.id]);
    for (const [attempt, ids] of byAttempt) {
      await enqueueChunks(queue, { id: job.id, publicId: job.public_id }, chunkIdRanges(ids, cfg.CHUNK_SIZE), attempt);
    }
    await jobsRepo.touchJob(pool, job.id);
    requeued += rows.length;
    logger.warn({ job: job.public_id, rows: rows.length }, 'reconciler re-enqueued stalled rows');
  }
  return requeued;
}
