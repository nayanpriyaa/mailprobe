import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import {
  HttpError,
  InvalidCursorError,
  KEY_PATTERN,
  accountsRepo,
  hashApiKey,
  takeToken,
  type Config,
  type Logger,
  type Pool,
  type Redis,
} from '@mailprobe/server';

export interface AuthContext {
  accountId: number;
  keyId: number;
}

/** Auth context lives on res.locals to avoid augmenting Express's global Request type. */
export function auth(res: Response): AuthContext {
  const ctx = res.locals.auth as AuthContext | undefined;
  if (!ctx) throw new HttpError(401, 'unauthorized', 'missing API key');
  return ctx;
}

function extractKey(req: Request): string | null {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.get('x-api-key')?.trim() ?? null;
}

export function requireApiKey(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    const key = extractKey(req);
    // Shape check first: garbage never reaches the database.
    if (!key || !KEY_PATTERN.test(key)) {
      throw new HttpError(401, 'unauthorized', 'provide an API key as "Authorization: Bearer mp_live_..."');
    }
    const found = await accountsRepo.findAccountIdByKeyHash(pool, hashApiKey(key));
    if (!found) throw new HttpError(401, 'unauthorized', 'invalid or revoked API key');
    res.locals.auth = found satisfies AuthContext;
    next();
  };
}

/**
 * Token-bucket rate limit in Redis, shared by all API replicas. Sets the IETF
 * draft RateLimit-* headers and Retry-After on 429.
 */
export function rateLimit(
  redis: Redis,
  opts: { keyFor: (req: Request, res: Response) => string; burst: number; perSec: number },
): RequestHandler {
  return async (req, res, next) => {
    const r = await takeToken(redis, `mp:rl:${opts.keyFor(req, res)}`, opts.burst, opts.perSec);
    res.setHeader('RateLimit-Limit', String(opts.burst));
    res.setHeader('RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
      throw new HttpError(429, 'rate_limited', 'too many requests; slow down', { retry_after_ms: r.retryAfterMs });
    }
    next();
  };
}

/** Explicit allowlist; the dashboard origin(s) come from CORS_ORIGINS. */
export function cors(cfg: Pick<Config, 'CORS_ORIGINS'>): RequestHandler {
  const allowed = new Set(cfg.CORS_ORIGINS);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (allowed.has(origin) || allowed.has('*'))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'RateLimit-Limit, RateLimit-Remaining, Retry-After, Location');
    }
    if (req.method === 'OPTIONS' && origin) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
};

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, 'not_found', 'no such endpoint'));
}

/** Single error-to-JSON mapping. Error bodies always look like { error: { code, message, details? } }. */
export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    let status = 500;
    let body: { code: string; message: string; details?: unknown } = { code: 'internal', message: 'internal server error' };

    if (err instanceof HttpError) {
      status = err.status;
      body = { code: err.code, message: err.message, details: err.details };
    } else if (err instanceof ZodError) {
      status = 400;
      body = {
        code: 'invalid_request',
        message: 'request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (err instanceof InvalidCursorError) {
      status = 400;
      body = { code: 'invalid_cursor', message: 'cursor is malformed or expired' };
    } else if (isBodyParserError(err)) {
      status = err.status;
      body =
        err.type === 'entity.too.large'
          ? { code: 'payload_too_large', message: 'request body too large' }
          : { code: 'invalid_body', message: 'request body could not be parsed' };
    }

    if (status >= 500) logger.error({ err, path: req.path }, 'unhandled error');
    if (!res.headersSent) res.status(status).json({ error: body });
    else res.end();
  };
}

function isBodyParserError(err: unknown): err is { status: number; type: string } {
  const e = err as { status?: unknown; type?: unknown };
  return typeof e?.status === 'number' && typeof e?.type === 'string';
}
