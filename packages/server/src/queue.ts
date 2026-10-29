import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const VERIFY_QUEUE = 'verify-chunks';

/**
 * One BullMQ job = one contiguous id range of a verification job. The payload only
 * carries ids; rows are re-read from MySQL, which stays the single source of truth.
 */
export interface ChunkPayload {
  jobId: number;
  publicId: string;
  fromId: number;
  toId: number;
  /** 0 for the first pass; incremented for each greylisting/timeout retry pass. */
  attempt: number;
}

export function createVerifyQueue(connection: Redis): Queue<ChunkPayload> {
  return new Queue<ChunkPayload>(VERIFY_QUEUE, {
    connection,
    defaultJobOptions: {
      // BullMQ-level retries cover crashes and infrastructure errors (DB down).
      // Mail-level retries (greylisting) are separate delayed jobs with their own attempt counter.
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
}

/**
 * Deterministic BullMQ job id: enqueueing the same chunk twice (request retry,
 * reconciler) is a no-op while the first copy still exists. BullMQ forbids ':' in ids.
 */
export const chunkJobId = (p: Pick<ChunkPayload, 'publicId' | 'fromId' | 'attempt'>): string =>
  `${p.publicId}-${p.fromId}-a${p.attempt}`;

export async function enqueueChunks(
  queue: Queue<ChunkPayload>,
  job: { id: number; publicId: string },
  ranges: Array<[number, number]>,
  attempt = 0,
  delayMs = 0,
): Promise<void> {
  // addBulk is one round trip (MULTI) regardless of chunk count.
  await queue.addBulk(
    ranges.map(([fromId, toId]) => {
      const data: ChunkPayload = { jobId: job.id, publicId: job.publicId, fromId, toId, attempt };
      return { name: 'chunk', data, opts: { jobId: chunkJobId(data), delay: delayMs } };
    }),
  );
}
