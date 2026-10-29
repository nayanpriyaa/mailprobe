# Mailprobe

Email verification as an API. Upload a list, and every address is checked against its domain's mail server without sending anything. Each address lands in one of four piles: **deliverable**, **undeliverable**, **risky** (catch-all, disposable, mailbox full) or **unknown**.

Built with Node.js, TypeScript, Express, MySQL, Redis/BullMQ, React and Tailwind CSS.

![Job results with the sorting bar](docs/screenshots/job.png)

## What it does

- **Single checks**: `POST /v1/verify` returns a verdict synchronously.
- **Bulk jobs**: upload a CSV with up to 50k rows (the email column is detected automatically). You get `202 Accepted`, a queue does the work, and results come back paginated or as a streamed CSV export.
- **Checks run cheapest first**, and a later check runs only if the earlier ones pass:
  1. RFC 5321/5322 syntax with IDN support
  2. Disposable domains (about 10k bundled), role accounts, free providers
  3. Typo suggestions (`gmial.com` → `gmail.com`)
  4. MX lookup, with RFC 5321 implicit-MX fallback and RFC 7505 null-MX detection
  5. SMTP `RCPT TO` probe with catch-all detection
- **SaaS plumbing**:
  - API keys, stored as hashes
  - A per-key token-bucket rate limit in Redis
  - Prepaid credits with atomic debits
  - Usage rollups
  - OpenAPI 3.1 docs with Swagger UI at `/docs`
- **Dashboard**: upload, live progress, filter, export, quick check, and key management. A built-in demo mode runs entirely in the browser.

## Architecture

```mermaid
flowchart LR
  UI[React dashboard] -->|REST + API key| API
  CLI[curl / SDK] --> API
  subgraph API["API (Express)"]
    A1[auth + token bucket] --> A2[ingest: parse CSV,<br/>dedupe, sort by domain]
  end
  A2 -->|1 transaction:<br/>debit credits, job, rows| DB[(MySQL)]
  A2 -->|chunk ranges<br/>after commit| Q[[BullMQ on Redis]]
  Q --> W1[worker] & W2[worker]
  W1 & W2 -->|verifyBatch| Core
  subgraph Core["@mailprobe/core"]
    S[syntax] --> D[disposable / role / typo] --> MX[DNS MX] --> SMTP[SMTP probe]
  end
  MX <-->|MX + catch-all cache| R[(Redis)]
  SMTP <-->|per-MX semaphore| R
  SMTP -->|"EHLO, MAIL FROM, RCPT TO"| MXS[(recipient MX servers)]
  W1 & W2 -->|guarded upsert<br/>+ counters| DB
```

What happens to an upload:

1. **Ingest.** The API normalizes and dedupes the addresses, then **sorts them by domain**. One transaction debits credits, creates the job and bulk-inserts the rows as `pending`. After the commit, the API enqueues one BullMQ job per 50-row id range.
2. **Process.** A worker loads the chunk's unfinished rows and verifies them as one batch. Because rows are sorted by domain, a chunk usually covers few domains. That means one MX lookup and one SMTP session handle many addresses, with up to 20 `RCPT TO`s per session.
3. **Persist.** In one transaction, the worker locks the chunk's rows with `SELECT … FOR UPDATE` and keeps only rows not yet `done`. It writes their verdicts with a single multi-row upsert and increments the job counters. This step is idempotent, so BullMQ's at-least-once redelivery never double-counts.
4. **Retry.** Greylisting (`451`), timeouts and throttling are parked as `retry` and re-enqueued as one delayed job with exponential backoff. After `MAX_ATTEMPTS` they settle as `unknown`.
5. **Recover.** A reconciler re-enqueues rows from jobs that stopped making progress. This covers a crash between commit and enqueue, or delayed jobs lost from Redis.

More detail and the trade-offs behind each choice: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

Requirements: Docker, or Node 22 with MySQL 8 and Redis 7.

```bash
# Offline demo: fake SMTP server + fixture DNS, no port 25 or internet needed
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

- Dashboard: http://localhost:5173 (choose **Create account**, or **Explore with sample data**)
- API docs: http://localhost:4000/docs

```bash
# Create an account and key
curl -s localhost:4000/v1/signup -H 'content-type: application/json' -d '{"email":"you@company.com"}'
export KEY=mp_live_...

# Verify one address
curl -s localhost:4000/v1/verify -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"email":"jane@acme.com"}'

# Bulk: upload a CSV, poll, export
curl -s "localhost:4000/v1/jobs?name=leads.csv" -H "authorization: Bearer $KEY" \
  -H 'content-type: text/csv' --data-binary @leads.csv
curl -s localhost:4000/v1/jobs/<id> -H "authorization: Bearer $KEY"
curl -s "localhost:4000/v1/jobs/<id>/export.csv?status=deliverable" -H "authorization: Bearer $KEY" -o clean.csv
```

The fake SMTP server answers by local part, so you can exercise every path:

| Local part prefix | Server behaviour |
|---|---|
| `bounce` | `550 5.1.1` user unknown |
| `full` | `552 5.2.2` mailbox full |
| `grey` | `451` greylisted on the first try, then `250` on retry |
| `block` | `550 5.7.1` policy block |
| anything else | `250` accepted |

Every address at `bigcorp.io` or `northwind.co` is accepted (catch-all), and `gmial.com` has no MX.

### Without Docker

```bash
npm install
cp .env.example .env        # points at local MySQL/Redis, fake SMTP, fixture DNS
npm run build:libs
npm run migrate
npm run dev:smtp            # terminal 1: fake SMTP on :2525
npm run dev:api             # terminal 2: API on :4000
npm run dev:worker          # terminal 3
npm run dev:web             # terminal 4: dashboard on :5173
```

## Project layout

```
packages/core        Verification engine. Zero runtime dependencies, Node built-ins only.
packages/fake-smtp   Deterministic SMTP server for tests, the demo and benchmarks.
packages/server      Config, MySQL pool, Redis + Lua scripts, BullMQ queue, repositories.
apps/api             Express API, OpenAPI spec, end-to-end tests.
apps/worker          Chunk processor and reconciler.
apps/web             React + Vite + Tailwind dashboard (with an in-browser demo mode).
db/migrations        Forward-only SQL migrations (checksummed).
bench/               Engine, pipeline and EXPLAIN ANALYZE benchmarks.
```

## Testing

```bash
npm test -w @mailprobe/core     # 92 tests: syntax, DNS edge cases, SMTP sessions against the fake server
npm test -w @mailprobe/server   # CSV parsing, ingest, cursors, key generation
TEST_DATABASE_URL=mysql://root:root@127.0.0.1:3306/mailprobe_test npm test -w @mailprobe/api
```

The API suite runs the real stack: Express, MySQL, Redis, a BullMQ worker and the fake SMTP server. It covers:

- signup, auth and key revocation
- credits, including the `402` path with no charge
- a CSV job that has to retry a greylisted address
- keyset pagination and CSV export
- rate limiting
- a chunk processed by three workers at once that must still count each row exactly once

CI runs all of it against MySQL 8.4 and Redis 7 service containers, then builds both Docker images.

## Performance

The engine benchmark (`npm run bench:engine`) uses 5,000 addresses across 250 domains, with 20–60 ms of latency per SMTP reply and the same concurrency and per-MX caps for both strategies:

| Strategy | Time | Throughput | SMTP sessions |
|---|---:|---:|---:|
| One session per address | 68.5 s | 4,383 / min | 5,000 |
| Domain-sorted chunks (what the worker does) | 25.5 s | **11,786 / min** | **462** |

That is 2.7× the throughput with 10.8× fewer connections. At 50–150 ms per reply the gap widens to **3.9×**, because batching saves round trips and round trips are the cost. Fewer connections also matter beyond speed: per-IP connection volume is what gets a prober rate-limited or blocklisted. Full numbers and method: [docs/BENCHMARK.md](docs/BENCHMARK.md).

Database access patterns, index choices and the `EXPLAIN ANALYZE` comparison (keyset vs `OFFSET`, composite index vs filter, rollup table vs `COUNT(*)`): [docs/DB-OPTIMIZATION.md](docs/DB-OPTIMIZATION.md).

## Limits and honest caveats

- **Port 25.** Real SMTP probing needs outbound port 25, which most cloud providers and ISPs block by default. Without it, set `SMTP_PROBE=false` and results stop at DNS, with reason `smtp_disabled`. See [docs/DEPLOY.md](docs/DEPLOY.md).
- **Probing is not delivery.** Some servers accept every `RCPT` at SMTP time and bounce later; catch-all detection only catches servers that accept a random address too. Others block probes outright, which shows up as `unknown`/`smtp_blocked`.
- **No STARTTLS.** Probes run in plaintext. Nothing sensitive is sent (no message body), but some servers require TLS before `RCPT`.
- The score is a transparent heuristic, not a trained model.

## License

MIT
