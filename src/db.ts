import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export type UpsertDeviceInput = {
  deviceId: string;
  userId?: number;
  gameId?: number;
  fcmToken: string;
  platform?: string;
  appVersion?: string;
};

export async function upsertDevice({
  deviceId,
  userId,
  gameId,
  fcmToken,
  platform,
  appVersion,
}: UpsertDeviceInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DELETE FROM devices WHERE fcm_token = $1 AND device_id <> $2', [
      fcmToken,
      deviceId,
    ]);

    await client.query('UPDATE devices SET active = false WHERE device_id = $1', [deviceId]);

    const { rows } = await client.query(
      `INSERT INTO devices (device_id, user_id, game_id, fcm_token, platform, app_version, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (device_id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         game_id = EXCLUDED.game_id,
         fcm_token = EXCLUDED.fcm_token,
         platform = EXCLUDED.platform,
         app_version = EXCLUDED.app_version,
         active = EXCLUDED.active,
         updated_at = now()
       RETURNING device_id, user_id, fcm_token`,
      [deviceId, userId, gameId, fcmToken, platform || null, appVersion || null]
    );

    await client.query('COMMIT');
    return {
      deviceId: rows[0].device_id as string,
      userId: rows[0].user_id as string | null,
      fcmToken: rows[0].fcm_token as string,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getTokensByUserId(userId: number) {
  const { rows } = await pool.query(
    'SELECT fcm_token FROM devices WHERE user_id = $1 AND active = true',
    [userId]
  );
  return rows.map((r) => r.fcm_token as string);
}

export async function getAllActiveTokensPage(limit: number, offset: number) {
  const { rows } = await pool.query(
    `SELECT fcm_token
     FROM devices
     WHERE active = true
     ORDER BY updated_at DESC, device_id ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.map((r) => r.fcm_token as string);
}

export async function getActiveTokensCount() {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM devices WHERE active = true'
  );
  return rows[0]?.count ?? 0;
}

export async function deleteToken(token: string) {
  await pool.query('DELETE FROM devices WHERE fcm_token = $1', [token]);
}

export async function deleteDeviceByIdentifiers(
  deviceId: string,
  fcmToken: string,
  userId: number,
  gameId: number
) {
  const { rowCount } = await pool.query(
    `DELETE FROM devices
     WHERE device_id = $1 AND fcm_token = $2 AND user_id = $3 AND game_id = $4`,
    [deviceId, fcmToken, userId, gameId]
  );
  return rowCount || 0;
}

export { pool };
