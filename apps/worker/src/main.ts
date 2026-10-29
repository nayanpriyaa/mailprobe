import { Worker } from 'bullmq';
import {
  VERIFY_QUEUE,
  createLogger,
  createPool,
  createRedis,
  createVerifier,
  createVerifyQueue,
  loadConfig,
  type ChunkPayload,
} from '@mailprobe/server';
import { processChunk, reconcile } from './processor.js';

const cfg = loadConfig();
const logger = createLogger(cfg, 'worker');
const pool = createPool(cfg);
// BullMQ needs its own connection for the blocking BRPOPLPUSH-style worker loop.
const queueRedis = createRedis(cfg);
const workerRedis = createRedis(cfg);
const cacheRedis = createRedis(cfg);
const queue = createVerifyQueue(queueRedis);
const verifier = createVerifier(cfg, cacheRedis);
const deps = { cfg, pool, queue, verifier, logger };

const worker = new Worker<ChunkPayload>(
  VERIFY_QUEUE,
  async (job) => {
    const started = Date.now();
    const report = await processChunk(deps, job.data);
    logger.debug({ chunk: job.id, ms: Date.now() - started, ...report }, 'chunk done');
    return report;
  },
  {
    connection: workerRedis,
    concurrency: cfg.WORKER_CONCURRENCY,
    // A chunk can legitimately run for minutes against slow MX hosts; the lock is
    // renewed automatically, this only bounds how long a dead worker holds a chunk.
    lockDuration: 120_000,
  },
);

worker.on('failed', (job, err) => logger.error({ chunk: job?.id, attempts: job?.attemptsMade, err }, 'chunk failed'));
worker.on('error', (err) => logger.error({ err }, 'worker error'));

const idleSeconds = Math.ceil((cfg.RECONCILE_INTERVAL_MS * 2) / 1000);
const reconciler = setInterval(() => {
  reconcile(deps, idleSeconds).catch((err) => logger.error({ err }, 'reconcile failed'));
}, cfg.RECONCILE_INTERVAL_MS);

logger.info(
  { concurrency: cfg.WORKER_CONCURRENCY, chunkSize: cfg.CHUNK_SIZE, smtpProbe: cfg.SMTP_PROBE, dns: cfg.DNS_MODE },
  'worker started',
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down; finishing in-flight chunks');
  clearInterval(reconciler);
  // worker.close() waits for running jobs, so no chunk is abandoned mid-transaction.
  await worker.close();
  await queue.close();
  await Promise.all([queueRedis.quit(), workerRedis.quit(), cacheRedis.quit()]);
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
