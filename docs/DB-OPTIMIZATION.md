# Database design and optimization

The schema is in [`db/migrations/001_init.sql`](../db/migrations/001_init.sql). Every index exists for a specific query; this page maps each query to its index and explains the alternatives that were rejected.

## Access patterns → indexes

| Query (where it runs) | Index | Notes |
|---|---|---|
| Resolve API key on every request | `api_keys.uq_api_keys_hash (key_hash)` | `BINARY(32)` SHA-256: 32-byte keys, one B-tree descent. |
| List an account's jobs, newest first | `jobs.ix_jobs_account_id (account_id, id)` | Keyset on `id DESC`. |
| Worker loads a chunk: `job_id = ? AND id BETWEEN ? AND ?` | `verifications.ix_verifications_job_id (job_id, id)` | Range scan of exactly the chunk. |
| Results page: `job_id = ? AND id > ? ORDER BY id LIMIT n` | same | No filesort: index order is the sort order. |
| Results filtered by verdict | `ix_verifications_job_status_id (job_id, status, id)` | Equality on the first two columns, range and order on the third. |
| Dedup within an upload | `uq_verifications_job_email (job_id, email)` | Also rejects double inserts if an upload is retried. |
| Reconciler: stuck jobs | `jobs.ix_jobs_status_updated (status, updated_at)` | Avoids scanning every completed job every minute. |
| Usage chart | `usage_daily PRIMARY KEY (account_id, day)` | Pre-aggregated: at most 365 rows per account, ever. |

`verifications` carries four secondary indexes, which costs extra work on every write. That's acceptable here: each row is written twice in its life (insert as `pending`, one upsert to `done`) and read many times (polling, pagination, export).

## Keyset pagination instead of OFFSET

`LIMIT 100 OFFSET 150000` makes InnoDB walk and discard 150,000 index entries before returning anything, so page N costs O(N). The API paginates with an opaque cursor that encodes the last id seen:

```sql
SELECT … FROM verifications
 WHERE job_id = ? AND id > ?      -- cursor
 ORDER BY id
 LIMIT 101                        -- one extra row says whether a next page exists
```

This is a single index seek plus 101 reads, whatever page you're on. The CSV export uses the same loop in pages of 1,000, writing to the socket with backpressure, so exporting 50k rows never holds them in memory.

## Writes

- **Bulk insert at ingest.** Multi-row `INSERT … VALUES (…),(…)` in batches of 1,000, inside the same transaction as the credit debit, means one round trip per 1,000 rows. Ids are read back afterwards rather than assumed contiguous (`innodb_autoinc_lock_mode = 2` can interleave).
- **One upsert per chunk.** The worker writes all verdicts for a chunk with a single `INSERT … VALUES … AS new ON DUPLICATE KEY UPDATE` against primary keys it already holds locks on. That's three statements per 50 addresses instead of 50.
- **Counters and completion in one UPDATE.** MySQL evaluates single-table `UPDATE` assignments left to right, so `status = IF(processed >= total, 'completed', …)` sees the incremented `processed`. A separate check would race.
- **Throttled `last_used_at`.** Key usage is recorded at most once a minute per key (`WHERE last_used_at < NOW() - INTERVAL 60 SECOND`), not once per request.

## Measured: EXPLAIN ANALYZE

`npm run bench:explain` seeds one job with 200,000 rows and runs each pair five times with `EXPLAIN ANALYZE`, reporting the median and the full plans:

```bash
docker compose up -d mysql && npm run migrate
DATABASE_URL=mysql://root:root@127.0.0.1:3306/mailprobe npm run bench:explain
```

It compares:

1. A results page at row 150,000 with `OFFSET`, against keyset.
2. A rare-status filter using only `(job_id, id)` (forced with `FORCE INDEX`), against the `(job_id, status, id)` composite.
3. The 30-day usage chart via `COUNT(*) … GROUP BY` over `verifications`, against a read of the `usage_daily` rollup.

Expected shape of the plans:

- **OFFSET**: an index range scan with `rows≈150,100`, and time that grows with the offset.
- **Keyset**: an index range scan with `rows=100`, roughly constant.
- **Forced `(job_id, id)` with a rare status**: scans the job's rows until it finds 100 matches. With a 2% status that is about 5,000 rows read.
- **Composite**: reads exactly 100.
- **`COUNT(*)`**: proportional to the account's history. The rollup reads ≤ 30 rows.

<!-- Paste the generated table from bench/results/explain-*.md below. -->

| Query | Median (ms) | Rows examined |
|---|---:|---:|
| _run `npm run bench:explain` and paste results here_ | | |
