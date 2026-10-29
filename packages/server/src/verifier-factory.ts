import { readFileSync } from 'node:fs';
import {
  DEFAULT_PROBE_OPTIONS,
  DnsMxResolver,
  StaticMxResolver,
  Verifier,
  systemDnsBackend,
  type MxLookup,
  type MxResolver,
} from '@mailprobe/core';
import type { Redis } from 'ioredis';
import type { Config } from './config.js';
import { RedisHostLimiter, RedisVerifierCache } from './redis/index.js';

export function createResolver(cfg: Config): MxResolver {
  if (cfg.DNS_MODE === 'fixtures') {
    const fixtures = JSON.parse(readFileSync(cfg.DNS_FIXTURES_PATH!, 'utf8')) as Record<string, MxLookup>;
    return new StaticMxResolver(fixtures);
  }
  return new DnsMxResolver(systemDnsBackend({ servers: cfg.DNS_SERVERS }));
}

/** Builds the Verifier used by both the API (single checks) and the worker (bulk). */
export function createVerifier(cfg: Config, redis: Redis): Verifier {
  // Lease must outlive the slowest possible session or a live session could lose its slot.
  const sessionCeilingMs = cfg.SMTP_CONNECT_TIMEOUT_MS + cfg.SMTP_COMMAND_TIMEOUT_MS * (cfg.SMTP_MAX_RCPT_PER_SESSION + 5);
  return new Verifier(
    {
      resolver: createResolver(cfg),
      cache: new RedisVerifierCache(redis),
      limiter: new RedisHostLimiter(redis, cfg.SMTP_MAX_PER_HOST, cfg.SMTP_HOST_WAIT_MS, sessionCeilingMs),
    },
    {
      domainConcurrency: cfg.DOMAIN_CONCURRENCY,
      smtp: cfg.SMTP_PROBE
        ? {
            ...DEFAULT_PROBE_OPTIONS,
            heloName: cfg.SMTP_HELO_NAME,
            mailFrom: cfg.SMTP_MAIL_FROM,
            port: cfg.SMTP_PORT,
            hostOverride: cfg.SMTP_HOST_OVERRIDE,
            connectTimeoutMs: cfg.SMTP_CONNECT_TIMEOUT_MS,
            commandTimeoutMs: cfg.SMTP_COMMAND_TIMEOUT_MS,
            maxRcptPerSession: cfg.SMTP_MAX_RCPT_PER_SESSION,
          }
        : null,
    },
  );
}
