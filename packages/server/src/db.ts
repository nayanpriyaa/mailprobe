import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import type { Config } from './config.js';

export type { Pool, PoolConnection };
export type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export function createPool(cfg: Pick<Config, 'DATABASE_URL' | 'DB_POOL_SIZE'>): Pool {
  const pool = mysql.createPool({
    uri: cfg.DATABASE_URL,
    connectionLimit: cfg.DB_POOL_SIZE,
    waitForConnections: true,
    // BIGINT ids come back as JS numbers while they are safe integers (< 2^53).
    supportBigNumbers: true,
    bigNumberStrings: false,
    // Store and read DATETIMEs as UTC regardless of server or container time zone.
    timezone: 'Z',
    enableKeepAlive: true,
  });
  // CURRENT_TIMESTAMP(3) uses the session time zone, so pin it per connection.
  pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return pool;
}

/**
 * Runs `fn` in a transaction on one pooled connection: commit on success, rollback
 * on any error, and always return the connection to the pool.
 */
export async function withTransaction<T>(pool: Pool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}
