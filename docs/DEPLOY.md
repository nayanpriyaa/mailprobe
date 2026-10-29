# Deploying

## The port 25 problem

SMTP probing needs **outbound TCP port 25**. AWS, GCP, Azure and most home ISPs block it by default, and some providers lift the block only on request. Check your provider's current policy before you plan around it. That gives you two ways to deploy.

### Option A: a public demo with probing off (free tiers work)

Set `SMTP_PROBE=false`. Everything works except the mailbox step: syntax, disposable/role/free flags, typo suggestions and MX checks all still run, and results report `smtp_disabled` instead of a mailbox verdict. The dashboard's **Explore with sample data** mode needs no backend at all.

- **Dashboard**: any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages).
  ```bash
  VITE_API_URL=https://api.yourdomain.com npm run build -w @mailprobe/web   # output: apps/web/dist
  ```
- **API + worker**: any container host (Railway, Render, Fly.io, a small VPS). Use the root `Dockerfile` for both:
  - API: `node apps/api/dist/server.js`
  - Worker: `node apps/worker/dist/main.js`
  - Migrations, as a release or one-off job before deploys: `node apps/api/dist/migrate.js`
- **MySQL 8 and Redis 7**: managed services from the same provider, or containers.

### Option B: real probing on a VPS

1. Get a VPS where outbound port 25 is open.
2. Give the server IP a hostname with **matching forward and reverse DNS** (A and PTR records). Many MXs refuse `EHLO` from IPs without valid rDNS.
3. Set:
   ```
   SMTP_PROBE=true
   SMTP_HELO_NAME=verify.yourdomain.com      # the PTR hostname
   SMTP_MAIL_FROM=bounces@yourdomain.com     # a real mailbox on a domain you control
   DNS_MODE=system
   ```
4. Publish SPF for the `MAIL FROM` domain that includes the server IP.
5. Run `docker compose up -d` (without the demo override), behind a reverse proxy that terminates TLS (Caddy or nginx). Set `TRUST_PROXY=true` so rate limits key on the real client IP.

Probe responsibly. Keep `SMTP_MAX_PER_HOST` low (the default is 3), and expect large providers to rate-limit or block a single IP that probes heavily.

## Environment reference

All variables are validated at startup in [`packages/server/src/config.ts`](../packages/server/src/config.ts). An invalid value fails fast with a readable message. Key ones:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `mysql://mailprobe:mailprobe@127.0.0.1:3306/mailprobe` | MySQL connection |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Queue, rate limits, caches |
| `CORS_ORIGINS` | (empty) | Comma-separated dashboard origins |
| `SMTP_PROBE` | `true` | Set `false` where port 25 is blocked |
| `SMTP_MAX_PER_HOST` | `3` | Concurrent sessions per MX host, across all workers |
| `WORKER_CONCURRENCY` | `4` | Chunks in flight per worker process |
| `CHUNK_SIZE` | `50` | Addresses per queue job |
| `MAX_ATTEMPTS` / `RETRY_BASE_DELAY_MS` | `3` / `300000` | Greylisting retry budget and first delay (doubles per attempt) |
| `RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SEC` | `60` / `10` | Per-key token bucket |
| `SIGNUP_CREDITS` | `1000` | Credits for a new account |

`SMTP_HOST_OVERRIDE` routes every probe to one host (the fake SMTP server). Startup refuses it when `NODE_ENV=production`.

## Operations

- **Health**: `GET /healthz` reports MySQL and Redis status (`503` if either is down). It is wired into the compose healthcheck.
- **Shutdown**: on `SIGTERM` the API drains in-flight requests and the worker finishes running chunks before exiting. The image runs under `tini` so signals arrive.
- **Logs**: structured JSON (pino). Authorization headers are redacted.
- **Backups**: MySQL is the only stateful store that matters. Redis holds only reconstructible state; the reconciler re-enqueues unfinished work.
