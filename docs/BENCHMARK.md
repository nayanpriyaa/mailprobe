# Benchmarks

## Engine: session batching

**Question.** How much does grouping addresses by domain into shared SMTP sessions save, compared with one session per address?

**Setup.** [`bench/engine.ts`](../bench/engine.ts). The same address list runs through the same `Verifier` two ways:

- *naive*: one `verify()` call per address, 16 in flight.
- *batched*: the list is sorted by domain, cut into chunks of 50, and each chunk goes to `verifyBatch()`, 16 chunks in flight. This is exactly what the worker does.

Both strategies share everything else:

- the fake SMTP server, with uniformly random per-reply latency
- static DNS, with 250 domains on 40 MX hosts
- domain popularity that follows a Zipf-like distribution (a few large companies, a long tail)
- a cap of 3 concurrent sessions per MX host
- an in-memory MX and catch-all cache

Hardware: 2-vCPU Xeon @ 2.1 GHz container, Node 22.23.

| Addresses | Reply latency | Strategy | Time | Throughput | SMTP sessions | RCPT commands | DNS lookups |
|---:|---|---|---:|---:|---:|---:|---:|
| 5,000 | 20–60 ms | naive | 68.5 s | 4,383 / min | 5,000 | 5,264 | 248 |
| 5,000 | 20–60 ms | batched | 25.5 s | **11,786 / min** | **462** | 5,330 | 248 |
| 2,000 | 50–150 ms | naive | 69.5 s | 1,726 / min | 2,000 | 2,238 | 225 |
| 2,000 | 50–150 ms | batched | 17.7 s | **6,792 / min** | **298** | 2,249 | 225 |

Both strategies produced identical verdicts for every address.

**Reading it:**

- A session costs about five round trips before the first `RCPT`: connect, banner, `EHLO`, `MAIL FROM`, and the catch-all probe. Batching pays that once per ~20 recipients instead of once per recipient. The saving therefore **grows with latency**: 2.7× at 40 ms, 3.9× at 100 ms. Real internet MX latency is closer to the second row.
- 10.8× fewer connections matters beyond speed. Connection rate per source IP is what mail providers rate-limit and blocklist on.
- DNS lookups equal the number of distinct domains in both modes. That is the result of the cache plus single-flight coalescing. Before coalescing was added, the batched run made 263 lookups for 248 domains, because parallel chunks of the same big domain raced the cache.
- RCPT counts are almost equal. The work per mailbox is the same; batching only removes per-connection overhead.

Reproduce: `npm run bench:engine -- 5000 250 40` (arguments: addresses, domains, mean latency in ms).

## Pipeline: API → queue → workers → MySQL

[`bench/pipeline.ts`](../bench/pipeline.ts) measures end to end through the real stack. It signs up, uploads N addresses, and polls until the job completes:

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
npm run bench:pipeline -- 10000 250
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --scale worker=4
npm run bench:pipeline -- 10000 250
```

Record the results here:

| Addresses | Workers | Upload accepted | Completed in | Throughput |
|---:|---:|---:|---:|---:|
| 10,000 | 1 | | | |
| 10,000 | 4 | | | |
