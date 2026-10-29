import { createLogger, createPool, createRedis, createVerifier, createVerifyQueue, loadConfig } from '@mailprobe/server';
import { buildApp } from './app.js';

const cfg = loadConfig();
const logger = createLogger(cfg, 'api');
const pool = createPool(cfg);
const redis = createRedis(cfg);
const queue = createVerifyQueue(redis);
const verifier = createVerifier(cfg, redis);

const app = buildApp({ cfg, pool, redis, queue, verifier, logger });
const server = app.listen(cfg.PORT, () => {
  logger.info({ port: cfg.PORT, smtpProbe: cfg.SMTP_PROBE, dns: cfg.DNS_MODE }, 'api listening');
});
// Long single-address checks can take tens of seconds against slow MX hosts.
server.requestTimeout = 120_000;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  // Stop accepting connections, let in-flight requests finish, then close resources.
  const force = setTimeout(() => process.exit(1), 15_000).unref();
  server.close(async () => {
    await queue.close();
    await redis.quit();
    await pool.end();
    clearTimeout(force);
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
