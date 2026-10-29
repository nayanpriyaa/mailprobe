import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'on', 'off'])
  .transform((v) => v === 'true' || v === '1' || v === 'on');

const csvList = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

/**
 * All runtime configuration, validated once at startup. A bad value fails fast
 * with a readable message instead of surfacing as a confusing runtime error later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url().default('mysql://mailprobe:mailprobe@127.0.0.1:3306/mailprobe'),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),

  // API
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGINS: csvList, // e.g. "http://localhost:5173,https://app.example.com"
  TRUST_PROXY: bool.default('false'),
  MAX_UPLOAD_ROWS: z.coerce.number().int().min(1).default(50_000),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
  SIGNUP_CREDITS: z.coerce.number().int().min(0).default(1000),
  /** Per-API-key token bucket: burst size and sustained requests/second. */
  RATE_LIMIT_BURST: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_PER_SEC: z.coerce.number().positive().default(10),
  /** Per-IP limit on /v1/signup: burst and refill per hour. */
  SIGNUP_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(5),

  // Verification engine
  SMTP_PROBE: bool.default('true'),
  SMTP_HELO_NAME: z.string().min(1).default('verify.mailprobe.local'),
  SMTP_MAIL_FROM: z.string().email().default('verify@mailprobe.local'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(25),
  /** Dev/bench only: send every probe to this host (the fake SMTP server). */
  SMTP_HOST_OVERRIDE: z.string().optional(),
  SMTP_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  SMTP_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
  SMTP_MAX_RCPT_PER_SESSION: z.coerce.number().int().min(1).max(100).default(20),
  /** Concurrent SMTP sessions per MX host across all workers. */
  SMTP_MAX_PER_HOST: z.coerce.number().int().min(1).default(3),
  SMTP_HOST_WAIT_MS: z.coerce.number().int().min(0).default(30_000),
  DNS_MODE: z.enum(['system', 'fixtures']).default('system'),
  DNS_FIXTURES_PATH: z.string().optional(),
  DNS_SERVERS: csvList,
  DOMAIN_CONCURRENCY: z.coerce.number().int().min(1).default(8),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  CHUNK_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
  /** Total attempts for retryable results (greylisting, timeouts) before settling on "unknown". */
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** First retry delay; doubles each attempt. Greylisting windows are typically 1-15 minutes. */
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(5 * 60_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.DNS_MODE === 'fixtures' && !cfg.DNS_FIXTURES_PATH) {
    throw new Error('Invalid configuration:\n  DNS_FIXTURES_PATH: required when DNS_MODE=fixtures');
  }
  if (cfg.NODE_ENV === 'production' && cfg.SMTP_HOST_OVERRIDE) {
    throw new Error('Invalid configuration:\n  SMTP_HOST_OVERRIDE: must not be set in production');
  }
  return cfg;
}
