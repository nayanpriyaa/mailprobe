import type { Pool, RowDataPacket } from '../db.js';

export interface UsageDay {
  day: string; // YYYY-MM-DD
  verifications: number;
  deliverable: number;
}

/** Reads the pre-aggregated table via its primary key (account_id, day): at most `days` rows. */
export async function getUsage(pool: Pool, accountId: number, days: number): Promise<UsageDay[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, verifications, deliverable
       FROM usage_daily
      WHERE account_id = ? AND day > UTC_DATE() - INTERVAL ? DAY
      ORDER BY day`,
    [accountId, days],
  );
  return rows.map((r) => ({ day: String(r.day), verifications: Number(r.verifications), deliverable: Number(r.deliverable) }));
}
