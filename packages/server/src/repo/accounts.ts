import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from '../db.js';
import { withTransaction } from '../db.js';
import { generateApiKey } from '../keys.js';
import { ConflictError } from '../errors.js';

export interface AccountRow {
  id: number;
  email: string;
  name: string | null;
  credits: number;
  created_at: Date;
}

export interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const isDuplicate = (err: unknown) => (err as { code?: string }).code === 'ER_DUP_ENTRY';

export async function createAccountWithKey(
  pool: Pool,
  input: { email: string; name: string | null; credits: number },
): Promise<{ account: AccountRow; apiKey: string }> {
  const key = generateApiKey();
  try {
    return await withTransaction(pool, async (conn) => {
      const [res] = await conn.execute<ResultSetHeader>(
        'INSERT INTO accounts (email, name, credits) VALUES (?, ?, ?)',
        [input.email, input.name, input.credits],
      );
      await conn.execute('INSERT INTO api_keys (account_id, name, prefix, key_hash) VALUES (?, ?, ?, ?)', [
        res.insertId,
        'Default',
        key.prefix,
        key.hash,
      ]);
      const account = await getAccount(conn, res.insertId);
      return { account: account!, apiKey: key.plaintext };
    });
  } catch (err) {
    if (isDuplicate(err)) throw new ConflictError('an account with this email already exists');
    throw err;
  }
}

export async function getAccount(db: Pool | PoolConnection, id: number): Promise<AccountRow | null> {
  const [rows] = await db.execute<(AccountRow & RowDataPacket)[]>(
    'SELECT id, email, name, credits, created_at FROM accounts WHERE id = ?',
    [id],
  );
  return rows[0] ?? null;
}

/** Resolves an API key hash to its account. Uses the unique index on key_hash: one B-tree lookup. */
export async function findAccountIdByKeyHash(pool: Pool, hash: Buffer): Promise<{ accountId: number; keyId: number } | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, account_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  // Throttled write: at most once a minute per key, not once per request.
  void pool
    .execute(
      'UPDATE api_keys SET last_used_at = NOW(3) WHERE id = ? AND (last_used_at IS NULL OR last_used_at < NOW(3) - INTERVAL 60 SECOND)',
      [row.id],
    )
    .catch(() => undefined);
  return { accountId: Number(row.account_id), keyId: Number(row.id) };
}

export async function listKeys(pool: Pool, accountId: number): Promise<ApiKeyRow[]> {
  const [rows] = await pool.execute<(ApiKeyRow & RowDataPacket)[]>(
    'SELECT id, name, prefix, last_used_at, revoked_at, created_at FROM api_keys WHERE account_id = ? ORDER BY id',
    [accountId],
  );
  return rows;
}

export async function createKey(pool: Pool, accountId: number, name: string): Promise<{ row: ApiKeyRow; apiKey: string }> {
  const key = generateApiKey();
  const [res] = await pool.execute<ResultSetHeader>(
    'INSERT INTO api_keys (account_id, name, prefix, key_hash) VALUES (?, ?, ?, ?)',
    [accountId, name, key.prefix, key.hash],
  );
  const [rows] = await pool.execute<(ApiKeyRow & RowDataPacket)[]>(
    'SELECT id, name, prefix, last_used_at, revoked_at, created_at FROM api_keys WHERE id = ?',
    [res.insertId],
  );
  return { row: rows[0]!, apiKey: key.plaintext };
}

/**
 * Revokes a key. Refuses to revoke the account's last active key, which would lock
 * the user out of an account that has no other way to log in.
 */
export async function revokeKey(pool: Pool, accountId: number, keyId: number): Promise<'revoked' | 'not_found' | 'last_key'> {
  return withTransaction(pool, async (conn) => {
    const [active] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM api_keys WHERE account_id = ? AND revoked_at IS NULL FOR UPDATE',
      [accountId],
    );
    if (!active.some((r) => Number(r.id) === keyId)) return 'not_found';
    if (active.length === 1) return 'last_key';
    await conn.execute('UPDATE api_keys SET revoked_at = NOW(3) WHERE id = ? AND account_id = ?', [keyId, accountId]);
    return 'revoked';
  });
}

/**
 * Atomic debit: the WHERE clause makes check-and-decrement one statement, so two
 * concurrent uploads cannot both pass a "credits >= n" check and overdraw.
 */
export async function debitCredits(conn: Pool | PoolConnection, accountId: number, amount: number): Promise<boolean> {
  if (amount === 0) return true;
  const [res] = await conn.execute<ResultSetHeader>(
    'UPDATE accounts SET credits = credits - ? WHERE id = ? AND credits >= ?',
    [amount, accountId, amount],
  );
  return res.affectedRows === 1;
}

export async function refundCredits(conn: Pool | PoolConnection, accountId: number, amount: number): Promise<void> {
  if (amount > 0) await conn.execute('UPDATE accounts SET credits = credits + ? WHERE id = ?', [amount, accountId]);
}
