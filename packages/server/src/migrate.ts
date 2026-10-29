import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';

/**
 * Forward-only SQL migrations: db/migrations/NNN_name.sql applied in filename order
 * and recorded in schema_migrations with a checksum. Editing an applied file is
 * refused (checksum mismatch) instead of silently diverging between environments.
 *
 * MySQL DDL auto-commits, so a failed migration is not rolled back; keep each
 * migration small and idempotent-safe.
 */
export async function runMigrations(databaseUrl: string, dir: string, log: (msg: string) => void = console.log): Promise<string[]> {
  const conn = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true });
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    )`);
    // Serialize concurrent deploys: only one process migrates at a time.
    await conn.query("SELECT GET_LOCK('mailprobe_migrations', 60)");

    const [appliedRows] = await conn.query<RowDataPacket[]>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(appliedRows.map((r) => [String(r.version), String(r.checksum)]));
    const files = readdirSync(dir)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();

    const ran: string[] = [];
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`migration ${file} was modified after being applied`);
        continue;
      }
      log(`applying ${file}`);
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)', [file, checksum]);
      ran.push(file);
    }
    await conn.query("SELECT RELEASE_LOCK('mailprobe_migrations')");
    return ran;
  } finally {
    await conn.end();
  }
}
