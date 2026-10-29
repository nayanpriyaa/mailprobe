# Architecture

## Components

| Component | Responsibility | Scales by |
|---|---|---|
| `apps/api` | Auth, rate limiting, credits, ingest, reads, export | Stateless; add replicas behind a load balancer |
| `apps/worker` | Verifies chunks, persists verdicts, schedules retries, reconciles | `--scale worker=N`; per-MX caps are global (Redis) so adding workers never multiplies load on one mail server |
| `packages/core` | The verification engine (no I/O dependencies beyond `node:net` and `node:dns`) | n/a, it's a library |
| MySQL | Source of truth: accounts, keys, jobs, every verdict, usage rollups | Vertical first; verifications partitions cleanly by `job_id` if needed |
| Redis | BullMQ queue, rate-limit buckets, per-MX semaphores, MX and catch-all cache | One instance is plenty at this scale |

## Verification pipeline (per address)

```
parse ─▶ disposable? ─▶ MX lookup ─▶ catch-all known? ─▶ SMTP session
  │          │              │                │                │
invalid   risky/         no_mx /          risky/       RCPT reply → verdict
_syntax   disposable     null_mx /        catch_all
                         dns_error
```

Each stage only runs if the previous one could not decide, so the expensive network work is reserved for addresses that need it.

### SMTP session strategy

A naive verifier opens one connection per address. This one opens **one session per domain per 20 recipients**:

```
220 banner
EHLO verify.example.com
MAIL FROM:<bounces@example.com>
RCPT TO:<mp-probe-3fa9c1d27e0b4a55@acme.com>   ← random address first
RCPT TO:<alice@acme.com>
RCPT TO:<bob@acme.com>
…
QUIT                                           ← never DATA: nothing is sent
```

- **The random address first** decides catch-all. If the server accepts a mailbox that cannot exist, every other answer is meaningless, so the remaining recipients are skipped and marked `risky/catch_all`. The result is cached for 24 h per domain.
- **`452 too many recipients`** mid-session lowers the session size to what the server accepted. The rest carry over to a new session.
- **MX failover** happens only on connection-level failures and `4xx/5xx` greetings. A `MAIL FROM` rejection is a policy decision about the prober and is reported, not retried against the backup MX.
- **Per-MX semaphore** (Redis, Lua, lease-based) caps concurrent sessions per mail host across every worker. Leases expire, so a crashed worker cannot leak a slot.

### Classification

Enhanced status codes (RFC 3463) win over reply text. Some cases are easy to get wrong:

| Reply | Verdict | Why |
|---|---|---|
| `550 5.1.1` | undeliverable / mailbox_not_found | The mailbox definitively doesn't exist. |
| `550 5.7.1 … Spamhaus` | **unknown** / smtp_blocked | The server rejected *the prober*, not the mailbox. Calling this undeliverable would be wrong and would make users delete good leads. |
| `451 4.7.1 greylisted` | unknown / greylisted, **retryable** | Greylisting is designed to pass on retry after a delay. |
| `452 4.5.3` | retry in a new session | This is a recipient-count limit, not a verdict. |
| `552 5.2.2` | risky / mailbox_full | The mailbox exists but mail will bounce for now. |
| DNS `ETIMEOUT` | unknown / dns_error, **retryable** | A temporary failure must never become "no MX". |

## Job lifecycle and correctness

```
          POST /v1/jobs
               │  one transaction: debit credits ▸ insert job ▸ bulk-insert rows (pending)
               ▼
   ┌───────── queued ─────────┐
   │   enqueue chunk ranges   │  (after commit; failure here is caught by the reconciler)
   ▼                          │
processing ◀── retry pass (delayed, exponential) ◀──┐
   │                                                 │ retryable && attempts < MAX
   │ worker: SELECT … FOR UPDATE (rows not done)     │
   │         multi-row upsert ▸ job counters ────────┘
   ▼
completed   (processed = total, set in the same UPDATE that bumps the counter)
```

### Why it's safe under failure

| Failure | What happens |
|---|---|
| API crashes after commit, before enqueue | The job sits `queued` with no progress. The reconciler finds it (`status, updated_at` index) and enqueues its pending rows. |
| Worker dies mid-chunk | The BullMQ lock expires and the chunk is redelivered. Rows already `done` are skipped by the guarded write. |
| Two workers process the same chunk | Both probe (wasted work, not wrong work). `SELECT … FOR UPDATE` serializes the writes, and the second writer finds no transitionable rows and writes nothing. The e2e test runs three processors on one chunk and asserts exact counts. |
| Same chunk enqueued twice | Deterministic BullMQ job id (`<job>-<firstRowId>-a<attempt>`) makes the second add a no-op while the first exists. |
| Redis loses delayed retry jobs | Rows stay `retry` with `retry_at` in the past. The reconciler re-enqueues them. |
| Two uploads race the credit balance | `UPDATE accounts SET credits = credits - ? WHERE id = ? AND credits >= ?` is a single atomic check-and-set. `affectedRows = 0` means 402. |

Lock order is always `verifications → jobs → usage_daily`, so concurrent workers cannot form a deadlock cycle.

## Trade-offs I chose deliberately

- **MySQL holds the payload; the queue holds only id ranges.** Queue messages stay tiny, MySQL stays the single source of truth, and a lost Redis costs re-enqueueing, not data. The cost is one extra read per chunk.
- **Rows are sorted by domain at ingest.** This is what makes chunks domain-dense. The cost is that results come back grouped by domain rather than in upload order. Adding an `input_index` column would restore upload order if users needed it.
- **The counters on `jobs` are a hot row.** Every chunk commit updates it. At 50 rows per chunk that's about 1 update per 50 verifications, far below what InnoDB handles. At much higher scale I'd buffer counters in Redis (`HINCRBY`) and flush periodically.
- **Hash-set disposable lookup, not a trie or Bloom filter.** The list is ~10k domains (a few hundred KB). A `Set` probed once per parent suffix is O(labels) with O(1) probes. A Bloom filter only pays off when the set doesn't fit in memory.
- **The API key hash is SHA-256, not bcrypt.** Keys carry ~190 bits of randomness, so brute force is infeasible regardless of hash speed. A slow hash would only add latency to every request.
- **A React SPA, not Next.js.** The dashboard is entirely behind an API key with no SEO or server-rendered content, so SSR would add a server to deploy and nothing to show for it.
- **Express 5 over Fastify.** Throughput is bound by SMTP round trips (hundreds of ms), not HTTP framework overhead.

## What I'd add next

- STARTTLS in the SMTP client (some MXs refuse `RCPT` without it).
- Refund credits for results that settle as `unknown`.
- Webhook on job completion (signed with HMAC), so clients don't need to poll.
- Per-provider rules (for example, treat `250` from providers known to accept-then-bounce as `risky`).
- Partitioning `verifications` by `job_id` hash once it reaches hundreds of millions of rows, plus a retention policy.
