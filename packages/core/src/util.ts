/** Runs `fn` over `items` with at most `limit` in flight. Preserves input order in the output. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/** Key-value cache with TTL. Implemented in-memory here and on Redis in the worker. */
export interface VerifierCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSec: number): Promise<void>;
}

export class InMemoryCache implements VerifierCache {
  private readonly store = new Map<string, { value: unknown; expires: number }>();

  constructor(private readonly maxEntries = 50_000) {}

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      // Map preserves insertion order: evict the oldest entry (FIFO; good enough for a TTL cache).
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + ttlSec * 1000 });
  }
}
