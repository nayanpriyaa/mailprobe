import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { parseAddress, type Verifier } from '@mailprobe/core';
import {
  HttpError,
  NotFoundError,
  PaymentRequiredError,
  ULID_PATTERN,
  accountsRepo,
  chunkIdRanges,
  csvRow,
  decodeCursor,
  encodeCursor,
  enqueueChunks,
  extractEmailColumn,
  jobsRepo,
  parseCsv,
  prepareUpload,
  ulid,
  usageRepo,
  withTransaction,
  type ChunkPayload,
  type Config,
  type Logger,
  type Pool,
  type Redis,
} from '@mailprobe/server';
import type { Queue } from 'bullmq';
import { EXPORT_COLUMNS, exportRow, jobDto, resultRowDto, verificationDto } from './dto.js';
import { auth, cors, errorHandler, notFound, rateLimit, requireApiKey, securityHeaders } from './middleware.js';

export interface AppDeps {
  cfg: Config;
  pool: Pool;
  redis: Redis;
  queue: Queue<ChunkPayload>;
  verifier: Verifier;
  logger: Logger;
}

const STATUS = z.enum(['deliverable', 'undeliverable', 'risky', 'unknown']);
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(64).optional(),
});

const OPENAPI = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');

export function buildApp(deps: AppDeps): Express {
  const { cfg, pool, redis, queue, verifier, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.TRUST_PROXY);
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));
  app.use(securityHeaders);
  app.use(cors(cfg));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: cfg.MAX_UPLOAD_BYTES }));

  // ---- public ---------------------------------------------------------------

  app.get('/healthz', async (_req, res) => {
    const [db, cache] = await Promise.allSettled([pool.query('SELECT 1'), redis.ping()]);
    const ok = db.status === 'fulfilled' && cache.status === 'fulfilled';
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      mysql: db.status === 'fulfilled' ? 'up' : 'down',
      redis: cache.status === 'fulfilled' ? 'up' : 'down',
    });
  });

  app.get('/openapi.yaml', (_req, res) => {
    res.type('application/yaml').send(OPENAPI);
  });

  // Swagger UI from a CDN: interactive docs without bundling a UI into the API image.
  app.get('/docs', (_req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:",
    );
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Mailprobe API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/openapi.yaml', dom_id: '#ui', persistAuthorization: true });</script>
</body></html>`);
  });

  const signupBody = z.object({
    email: z.string().max(254),
    name: z.string().trim().max(120).optional(),
  });
  app.post(
    '/v1/signup',
    rateLimit(redis, {
      keyFor: (req) => `signup:${req.ip}`,
      burst: cfg.SIGNUP_LIMIT_PER_HOUR,
      perSec: cfg.SIGNUP_LIMIT_PER_HOUR / 3600,
    }),
    async (req, res) => {
      const body = signupBody.parse(req.body);
      const parsed = parseAddress(body.email);
      if (!parsed.ok) throw new HttpError(400, 'invalid_email', `email is not valid (${parsed.error})`);
      const { account, apiKey } = await accountsRepo.createAccountWithKey(pool, {
        email: parsed.address.normalized,
        name: body.name ?? null,
        credits: cfg.SIGNUP_CREDITS,
      });
      res.status(201).json({
        account: { email: account.email, name: account.name, credits: account.credits, created_at: account.created_at },
        api_key: apiKey,
        note: 'Store this key now. It is shown only once.',
      });
    },
  );

  // ---- authenticated --------------------------------------------------------

  const v1 = express.Router();
  v1.use(requireApiKey(pool));
  v1.use(
    rateLimit(redis, {
      keyFor: (_req, res) => `key:${auth(res).keyId}`,
      burst: cfg.RATE_LIMIT_BURST,
      perSec: cfg.RATE_LIMIT_PER_SEC,
    }),
  );

  v1.get('/me', async (_req, res) => {
    const account = await accountsRepo.getAccount(pool, auth(res).accountId);
    if (!account) throw new NotFoundError('account');
    res.json({ email: account.email, name: account.name, credits: account.credits, created_at: account.created_at });
  });

  v1.get('/keys', async (_req, res) => {
    const keys = await accountsRepo.listKeys(pool, auth(res).accountId);
    res.json({
      data: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        last_used_at: k.last_used_at,
        revoked_at: k.revoked_at,
        created_at: k.created_at,
        current: k.id === auth(res).keyId,
      })),
    });
  });

  v1.post('/keys', async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const { row, apiKey } = await accountsRepo.createKey(pool, auth(res).accountId, name);
    res.status(201).json({ id: row.id, name: row.name, prefix: row.prefix, created_at: row.created_at, api_key: apiKey });
  });

  v1.delete('/keys/:id', async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const outcome = await accountsRepo.revokeKey(pool, auth(res).accountId, id);
    if (outcome === 'not_found') throw new NotFoundError('api key');
    if (outcome === 'last_key') throw new HttpError(409, 'last_key', 'create another key before revoking your last one');
    res.status(204).end();
  });

  // Single, synchronous verification.
  v1.post('/verify', async (req, res) => {
    const { email } = z.object({ email: z.string().min(1).max(320) }).parse(req.body);
    const { accountId } = auth(res);
    if (!(await accountsRepo.debitCredits(pool, accountId, 1))) {
      const account = await accountsRepo.getAccount(pool, accountId);
      throw new PaymentRequiredError(1, account?.credits ?? 0);
    }
    let result;
    try {
      result = await verifier.verify(email);
    } catch (err) {
      await accountsRepo.refundCredits(pool, accountId, 1);
      throw err;
    }
    await jobsRepo.insertSingleVerification(pool, accountId, result);
    await jobsRepo.recordUsage(pool, accountId, 1, result.status === 'deliverable' ? 1 : 0);
    res.json(verificationDto(result));
  });

  // Bulk: CSV body (Content-Type: text/csv) or JSON { emails: [...] }.
  const jsonUpload = z.object({
    name: z.string().trim().max(255).optional(),
    emails: z.array(z.string().max(320)).min(1),
  });
  v1.post('/jobs', async (req, res) => {
    let raw: string[];
    let name: string | null;
    if (typeof req.body === 'string') {
      raw = extractEmailColumn(parseCsv(req.body));
      name = z.string().trim().max(255).optional().parse(req.query.name) ?? null;
    } else {
      const body = jsonUpload.parse(req.body);
      raw = body.emails;
      name = body.name ?? null;
    }
    if (raw.length > cfg.MAX_UPLOAD_ROWS) {
      throw new HttpError(413, 'too_many_rows', `uploads are limited to ${cfg.MAX_UPLOAD_ROWS} rows; got ${raw.length}`);
    }
    const upload = prepareUpload(raw);
    if (upload.rows.length === 0) throw new HttpError(422, 'empty_upload', 'no addresses found in the upload');

    const { accountId } = auth(res);
    const publicId = ulid();
    // Debit, job and rows commit atomically: no charge without a job, no job without a charge.
    const { jobId, rowIds } = await withTransaction(pool, async (conn) => {
      if (!(await accountsRepo.debitCredits(conn, accountId, upload.rows.length))) {
        const account = await accountsRepo.getAccount(conn, accountId);
        throw new PaymentRequiredError(upload.rows.length, account?.credits ?? 0);
      }
      return jobsRepo.insertJobWithRows(conn, {
        publicId,
        accountId,
        name,
        rows: upload.rows,
        duplicatesRemoved: upload.duplicatesRemoved,
      });
    });

    // Enqueue after commit so workers never see a chunk whose rows are not visible yet.
    // If this fails, the job stays 'queued' and the worker's reconciler re-enqueues it.
    try {
      await enqueueChunks(queue, { id: jobId, publicId }, chunkIdRanges(rowIds, cfg.CHUNK_SIZE));
    } catch (err) {
      logger.error({ err, publicId }, 'enqueue failed; reconciler will retry');
    }

    const job = await jobsRepo.getJobByPublicId(pool, accountId, publicId);
    res.status(202).location(`/v1/jobs/${publicId}`).json(jobDto(job!));
  });

  v1.get('/jobs', async (req, res) => {
    const q = pageQuery.parse(req.query);
    const rows = await jobsRepo.listJobs(pool, auth(res).accountId, decodeCursor(q.cursor), q.limit + 1);
    const page = rows.slice(0, q.limit);
    res.json({
      data: page.map(jobDto),
      next_cursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!.id) : null,
    });
  });

  const loadJob = async (accountId: number, id: string) => {
    if (!ULID_PATTERN.test(id)) throw new NotFoundError('job');
    const job = await jobsRepo.getJobByPublicId(pool, accountId, id);
    if (!job) throw new NotFoundError('job');
    return job;
  };

  v1.get('/jobs/:id', async (req, res) => {
    res.json(jobDto(await loadJob(auth(res).accountId, req.params.id!)));
  });

  v1.get('/jobs/:id/results', async (req, res) => {
    const job = await loadJob(auth(res).accountId, req.params.id!);
    const q = pageQuery.extend({ status: STATUS.optional() }).parse(req.query);
    const rows = await jobsRepo.listResults(pool, job.id, {
      status: q.status,
      afterId: decodeCursor(q.cursor),
      limit: q.limit + 1, // one extra row tells us whether there is a next page
    });
    const page = rows.slice(0, q.limit);
    res.json({
      data: page.map(resultRowDto),
      next_cursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!.id) : null,
    });
  });

  // Streams the whole result set without holding it in memory: keyset pages of 1000,
  // respecting socket backpressure, stopping if the client goes away.
  v1.get('/jobs/:id/export.csv', async (req, res) => {
    const job = await loadJob(auth(res).accountId, req.params.id!);
    const { status } = z.object({ status: STATUS.optional() }).parse(req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mailprobe-${job.public_id}${status ? `-${status}` : ''}.csv"`);
    res.write(csvRow(EXPORT_COLUMNS));

    let afterId: number | null = null;
    let aborted = false;
    req.on('close', () => (aborted = true));
    while (!aborted) {
      const rows = await jobsRepo.listResults(pool, job.id, { status, afterId, limit: 1000 });
      if (rows.length === 0) break;
      const chunk = rows.map((r) => csvRow(exportRow(r))).join('');
      if (!res.write(chunk)) await once(res, 'drain');
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < 1000) break;
    }
    res.end();
  });

  v1.get('/usage', async (req, res) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    res.json({ data: await usageRepo.getUsage(pool, auth(res).accountId, days) });
  });

  app.use('/v1', v1);
  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
