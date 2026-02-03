import 'dotenv/config';
import express from 'express';
import figlet from 'figlet';
import { fcm } from './firebase';
import { upsertDevice, getTokensByUserId, deleteToken } from './db';

const chalk = require("chalk");
const app = express();
app.use(express.json());

// health
app.get('/health', (_, res) => res.json({ ok: true }));

/**
 * REGISTER DEVICE
 * body: { deviceId, userId?, fcmToken, platform?, appVersion? }
 */
app.post('/devices/register', async (req, res) => {
  const { deviceId, userId, fcmToken, platform, appVersion } = req.body || {};

  if (!deviceId || !fcmToken) {
    return res.status(400).json({ error: 'deviceId and fcmToken are required' });
  }

  try {
    const result = await upsertDevice({ deviceId, userId, fcmToken, platform, appVersion });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/**
 * SEND TO ONE TOKEN
 * body: { token, title, body, data?, image? }
 */
app.post('/push/token', async (req, res) => {
  const { token, title, body, data, image } = req.body || {};
  if (!token || !title || !body) {
    return res.status(400).json({ error: 'token, title, body are required' });
  }

  try {
    const msgId = await fcm().send({
      token,
      notification: { title, body, image: image || undefined },
      data: data || undefined, // data must be Record<string,string>
    });
    res.json({ ok: true, msgId });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/**
 * SEND TO USER (all their devices)
 * body: { userId, title, body, data?, image? }
 */
app.post('/push/user', async (req, res) => {
  const { userId, title, body, data, image } = req.body || {};
  if (!userId || !title || !body) {
    return res.status(400).json({ error: 'userId, title, body are required' });
  }

  let tokens: string[] = [];
  try {
    tokens = await getTokensByUserId(userId);
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
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
        notification: { title, body, image: image || undefined },
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
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/**
 * SEND TO TOPIC (e.g. "all")
 * body: { topic?, title, body, data?, image? }
 */
app.post('/push/topic', async (req, res) => {
  const { topic, title, body, data, image } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title, body are required' });

  const t = topic || process.env.DEFAULT_TOPIC || 'all';

  try {
    const msgId = await fcm().send({
      topic: t,
      notification: { title, body, image: image || undefined },
      data: data || undefined,
    });
    res.json({ ok: true, topic: t, msgId });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
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

  console.log(chalk.blue(figlet.textSync('LOTO', { horizontalLayout: 'full' })));
  console.log(chalk.yellow(figlet.textSync('NOTIFICATION SERVICE', { horizontalLayout: 'full' })));
  console.log(chalk.green(`PORT: ${port}`));
}

bootstrap();
