import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

export function createLogger(cfg: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>, name: string): Logger {
  return pino({
    name,
    level: cfg.NODE_ENV === 'test' ? 'silent' : cfg.LOG_LEVEL,
    // Never log credentials, even by accident in a request dump.
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.plaintext'],
  });
}
