/**
 * Caps concurrent SMTP connections per mail host. Hammering one MX with parallel
 * connections is the fastest way to get the prober's IP rate-limited or listed.
 *
 * `acquire` resolves to a release function, or null if a slot did not free up
 * within the wait budget (the caller then reports a retryable "throttled" result
 * instead of blocking a worker indefinitely).
 */
export type Release = () => Promise<void>;

export interface HostLimiter {
  acquire(host: string): Promise<Release | null>;
}

/** Single-process implementation. The worker uses a Redis-backed one shared across processes. */
export class InMemoryHostLimiter implements HostLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Array<(granted: boolean) => void>>();

  constructor(
    private readonly maxPerHost: number,
    private readonly maxWaitMs = 30_000,
  ) {
    if (maxPerHost < 1) throw new RangeError('maxPerHost must be >= 1');
  }

  async acquire(host: string): Promise<Release | null> {
    const n = this.active.get(host) ?? 0;
    if (n < this.maxPerHost) {
      this.active.set(host, n + 1);
      return this.releaser(host);
    }

    const granted = await new Promise<boolean>((resolve) => {
      const queue = this.queues.get(host) ?? [];
      this.queues.set(host, queue);
      const timer = setTimeout(() => {
        const i = queue.indexOf(wake);
        if (i !== -1) queue.splice(i, 1);
        resolve(false);
      }, this.maxWaitMs);
      const wake = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      queue.push(wake);
    });
    // On grant, the releasing caller handed its slot over directly; `active` is unchanged.
    return granted ? this.releaser(host) : null;
  }

  private releaser(host: string): Release {
    let released = false;
    return async () => {
      if (released) return; // idempotent: double release must not free two slots
      released = true;
      const next = this.queues.get(host)?.shift();
      if (next) {
        next(true); // hand the slot to the next waiter (FIFO, no thundering herd)
        return;
      }
      const n = (this.active.get(host) ?? 1) - 1;
      if (n <= 0) this.active.delete(host);
      else this.active.set(host, n);
      if (this.queues.get(host)?.length === 0) this.queues.delete(host);
    };
  }
}
