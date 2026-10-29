import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import type { HostLimiter, Release, VerifierCache } from '@mailprobe/core';
import type { Config } from '../config.js';

export { Redis };

/**
 * `maxRetriesPerRequest: null` is required by BullMQ for blocking commands and is
 * harmless elsewhere: commands wait for a reconnect instead of failing fast.
 */
export function createRedis(cfg: Pick<Config, 'REDIS_URL'>): Redis {
  return new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

const load = (name: string) => readFileSync(new URL(`./${name}.lua`, import.meta.url), 'utf8');

class Script {
  readonly sha: string;
  constructor(readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  /** EVALSHA, falling back to EVAL once if Redis has not cached the script (restart, failover). */
  async run(redis: Redis, keys: string[], args: Array<string | number>): Promise<unknown> {
    try {
      return await redis.evalsha(this.sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NOSCRIPT')) {
        return redis.eval(this.source, keys.length, ...keys, ...args);
      }
      throw err;
    }
  }
}

const tokenBucketScript = new Script(load('token-bucket'));
const semaphoreScript = new Script(load('semaphore-acquire'));

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export async function takeToken(
  redis: Redis,
  key: string,
  capacity: number,
  refillPerSec: number,
  cost = 1,
): Promise<RateLimitResult> {
  const [allowed, remaining, retry] = (await tokenBucketScript.run(redis, [key], [capacity, refillPerSec, cost])) as [
    number,
    number,
    number,
  ];
  return { allowed: allowed === 1, remaining, retryAfterMs: retry };
}

/**
 * Cross-process HostLimiter: at most `maxPerHost` SMTP sessions per MX host across
 * every worker replica. Leases expire, so a crashed worker cannot leak a slot.
 */
export class RedisHostLimiter implements HostLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly maxPerHost: number,
    private readonly maxWaitMs: number,
    /** Upper bound on one SMTP session; must exceed connect + all command timeouts. */
    private readonly leaseMs: number,
  ) {}

  async acquire(host: string): Promise<Release | null> {
    const key = `mp:sem:${host}`;
    const token = randomUUID();
    const deadline = Date.now() + this.maxWaitMs;
    let backoff = 25;
    for (;;) {
      const ok = await semaphoreScript.run(this.redis, [key], [this.maxPerHost, this.leaseMs, token]);
      if (ok === 1) {
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await this.redis.zrem(key, token);
        };
      }
      if (Date.now() + backoff > deadline) return null;
      // Jittered exponential backoff so waiting workers do not poll in lockstep.
      await new Promise((r) => setTimeout(r, backoff / 2 + Math.random() * backoff));
      backoff = Math.min(backoff * 2, 1000);
    }
  }
}

/** Shared MX / catch-all cache, so every worker benefits from every other worker's lookups. */
export class RedisVerifierCache implements VerifierCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'mp:cache:',
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', Math.max(1, Math.round(ttlSec)));
  }
}
