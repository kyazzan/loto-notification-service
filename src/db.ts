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
  userId?: string;
  fcmToken: string;
  platform?: string;
  appVersion?: string;
};

export async function upsertDevice({
  deviceId,
  userId,
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

    const { rows } = await client.query(
      `INSERT INTO devices (device_id, user_id, fcm_token, platform, app_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (device_id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         fcm_token = EXCLUDED.fcm_token,
         platform = EXCLUDED.platform,
         app_version = EXCLUDED.app_version,
         updated_at = now()
       RETURNING device_id, user_id, fcm_token`,
      [deviceId, userId || null, fcmToken, platform || null, appVersion || null]
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

export async function getTokensByUserId(userId: string) {
  const { rows } = await pool.query('SELECT fcm_token FROM devices WHERE user_id = $1', [
    userId,
  ]);
  return rows.map((r) => r.fcm_token as string);
}

export async function deleteToken(token: string) {
  await pool.query('DELETE FROM devices WHERE fcm_token = $1', [token]);
}

export { pool };
