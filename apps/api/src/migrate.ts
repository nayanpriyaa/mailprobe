import { fileURLToPath } from 'node:url';
import { loadConfig, runMigrations } from '@mailprobe/server';

const cfg = loadConfig();
const dir = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../db/migrations', import.meta.url));
const ran = await runMigrations(cfg.DATABASE_URL, dir);
console.log(ran.length > 0 ? `applied ${ran.length} migration(s)` : 'database is up to date');
