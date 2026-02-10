import 'dotenv/config';
import express from 'express';
import figlet from 'figlet';
import { fcm } from './firebase';
import { initKafkaNotificationReader } from './kafka';
import {
  upsertDevice,
  getTokensByUserId,
  getAllActiveTokensPage,
  getActiveTokensCount,
  deleteToken,
  deleteDeviceByIdentifiers,
} from './db';

const chalk = require("chalk");
const app = express();
app.use(express.json());

function sendError(res: express.Response, status: number, message: string) {
  return res.status(status).json({ ok: false,  message });
}

// health
app.get('/health', (_, res) => res.json({ ok: true }));

/**
 * REGISTER DEVICE
 * body: { deviceId, userId?, gameId? | game_id?, fcmToken, platform?, appVersion? }
 */
app.post('/devices/register', async (req, res) => {
  const { deviceId, userId, gameId, fcmToken, platform, appVersion } = req.body || {};

  if (deviceId == null) return sendError(res, 400, 'deviceId required');

  if (fcmToken == null) return sendError(res, 400, 'fcmToken are required');

  if (userId == null) return sendError(res, 400, 'userId are required');

  if (gameId == null) return sendError(res, 400, 'gameId are required');

  try {
    const result = await upsertDevice({
      deviceId,
      userId,
      gameId,
      fcmToken,
      platform,
      appVersion,
    });

    res.json({ ok: true, ...result });
  } catch (e) {
    return sendError(res, 500, (e as Error).message);
  }
});

/**
 * REMOVE DEVICE
 * body: { deviceId, fcmToken, userId, gameId }
 */
app.post('/devices/remove', async (req, res) => {
  const { deviceId, fcmToken, userId, gameId } = req.body || {};

  if (deviceId == null) return sendError(res, 400, 'deviceId required');
  if (fcmToken == null) return sendError(res, 400, 'fcmToken are required');
  if (userId == null) return sendError(res, 400, 'userId are required');
  if (gameId == null) return sendError(res, 400, 'gameId are required');

  try {
    const removed = await deleteDeviceByIdentifiers(deviceId, fcmToken, userId, gameId);
    res.json({ ok: true, removed });
  } catch (e) {
    return sendError(res, 500, (e as Error).message);
  }
});

/**
 * SEND TO ONE TOKEN
 * body: { token, title, body, data?, image? }
 */
app.post('/push/token', async (req, res) => {
  const { token, title, body, data, image } = req.body || {};
  if (!token || !title || !body) {
    return sendError(res, 400, 'token, title, body are required');
  }

  try {
    const msgId = await fcm().send({
      token,
      notification: { title, body, imageUrl: image || undefined },
      data: data || undefined, // data must be Record<string,string>
    });
    res.json({ ok: true, msgId });
  } catch (e) {
    return sendError(res, 500, (e as Error).message);
  }
});

/**
 * SEND TO USER (all their devices)
 * body: { userId, title, body, data?, image? }
 */
app.post('/push/user', async (req, res) => {
  const { userId, title, body, data, image } = req.body || {};
  if (!userId || !title || !body) {
    return sendError(res, 400, 'userId, title, body are required');
  }

  let tokens: string[] = [];
  try {
    tokens = await getTokensByUserId(userId);
  } catch (e) {
    return sendError(res, 500, (e as Error).message);
  }

  if (!tokens.length) return res.json({ ok: true, sent: 0, info: 'No tokens for user' });

  // FCM multicast: до 500 токенов за раз
  const chunks = chunk(tokens, 500);

  let sent = 0;
  let failed = 0;
  const deadTokens: string[] = [];

  try {
    for (const part of chunks) {
      const resp = await fcm().sendEachForMulticast({
        tokens: part,
        notification: { title, body, imageUrl: image || undefined },
        data: data || undefined,
      });

      sent += resp.successCount;
      failed += resp.failureCount;

      // чистим мёртвые токены
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code || '';
          if (
            code.includes('registration-token-not-registered') ||
            code.includes('invalid-registration-token')
          ) {
            deadTokens.push(part[idx]);
          }
        }
      });
    }

    // удалить мёртвые токены из БД
    await Promise.all(deadTokens.map((t) => deleteToken(t)));

    res.json({ ok: true, sent, failed, removedDead: deadTokens.length });
  } catch (e) {
    return sendError(res, 500, (e as Error).message);
  }
});

/**
 * SEND TO TOPIC (e.g. "all")
 * body: { title, body, data?, image? }
 */
app.post('/push/all', async (req, res) => {
  const { title, body, data, image } = req.body || {};
  if (!title || !body) return sendError(res, 400, 'title, body are required');

  try {
    const limit = 20;
    const total = await getActiveTokensCount();
    if (total === 0) return res.json({ ok: true, sent: 0, info: 'No active users' });

    let sent = 0;
    let failed = 0;
    const totalPages = Math.ceil(total / limit);

    for (let page = 0; page < totalPages; page += 1) {
      const offset = page * limit;
      const tokens = await getAllActiveTokensPage(limit, offset);
      if (!tokens.length) continue;

      const resp = await fcm().sendEachForMulticast({
        tokens,
        notification: { title, body, imageUrl: image || undefined },
        data: data || undefined,
      });

      sent += resp.successCount;
      failed += resp.failureCount;
    }

    res.json({ ok: true, sent, failed });
  } catch (e) {
    return sendError(res, 500, (e as Error).message);
  }
});

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function bootstrap() {
  const port = Number(process.env.APP_PORT || process.env.PORT || 3000);
  await new Promise<void>((resolve, reject) => {
    app
      .listen(port, () => resolve())
      .on('error', (err) => reject(err));
  });

  if (process.env.KAFKA_READ_TOPIC) {
    initKafkaNotificationReader();
  }

  console.log(chalk.blue(figlet.textSync('LOTO', { horizontalLayout: 'full' })));
  console.log(chalk.yellow(figlet.textSync('NOTIFICATION SERVICE', { horizontalLayout: 'full' })));
  console.log(chalk.green(`PORT: ${port}`));
}

bootstrap();
