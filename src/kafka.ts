import { Kafka } from 'kafkajs';
import { fcm } from './firebase';
import { deleteToken, getTokensByUserId } from './db';

export interface KafkaDto {
  eventName: string;
  data: {
    senderIds: number[];
    data: any;
  };
}

let writer: import('kafkajs').Producer;

export async function initKafkaWriter() {
  const brokers = process.env.KAFKA_BROKERS?.split(',').map(b => b.trim()).filter(b => b) || [];
  if (!brokers.length) {
    throw new Error('KAFKA_BROKERS environment variable is required but not set');
  }

  const topic = process.env.KAFKA_WRITE_TOPIC;
  if (!topic) {
    throw new Error('KAFKA_WRITE_TOPIC environment variable is required but not set');
  }

  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'default-client',
    brokers,
  });

  createKafkaTopic(kafka, brokers, topic).catch(err => {
    console.error(`Failed to connect or create topic ${topic}:`, err);
    process.exit(1);
  });

  writer = kafka.producer();
  try {
    await writer.connect()
  } catch (err) {
    console.error('Kafka writer connection error:')
  };

  console.log(`Initializing Kafka writer with brokers: ${brokers}, topic: ${topic}`);
}

async function createKafkaTopic(kafka: Kafka, brokers: string[], topic: string) {
  const admin = kafka.admin();
  await admin.connect();

  try {
    const topics = await admin.listTopics();
    if (topics.includes(topic)) {
      console.log(`Topic ${topic} already exists, connecting to it`);
      return;
    }

    console.log(`Topic ${topic} does not exist, creating it`);
    await admin.createTopics({
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    });
    console.log(`Successfully created topic ${topic}`);
  } catch (err) {
    console.error(`Failed to create topic ${topic}:`, err);
    throw err;
  } finally {
    await admin.disconnect();
  }
}

export function initKafkaReader(broadcastFunc: (msg: string) => void | Promise<void>) {
  const brokers = process.env.KAFKA_BROKERS?.split(',').map(b => b.trim()).filter(b => b) || [];
  if (!brokers.length) {
    throw new Error('KAFKA_BROKERS environment variable is required but not set');
  }

  const groupId = process.env.KAFKA_GROUP_ID;
  if (!groupId) {
    throw new Error('KAFKA_GROUP_ID environment variable is required but not set');
  }

  const topic = process.env.KAFKA_READ_TOPIC;
  if (!topic) {
    throw new Error('KAFKA_READ_TOPIC environment variable is required but not set');
  }

  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID || 'default-client',
    brokers,
  });

  createKafkaTopic(kafka, brokers, topic).catch(err => {
    console.error(`Failed to connect or create topic ${topic}:`, err);
    process.exit(1);
  });

  const reader = kafka.consumer({ groupId });
  console.log(`Initializing Kafka reader with brokers: ${brokers}, topic: ${topic}, groupId: ${groupId}`);

  reader.connect().then(() => {
    reader.subscribe({ topic, fromBeginning: true }).then(() => {
      reader.run({
        eachMessage: async ({ message }) => {
          if (message.value) {
            const msg = message.value.toString();
            // console.log(`Received Kafka message from topic ${topic}: value=${msg}`);
            await broadcastFunc(msg);
          }
        },
      });
    });
  }).catch(err => console.error('Kafka reader connection error:', err));
}

export async function writeKafkaMessage(msg: string) {
  try {
    await writer.send({
      topic: process.env.KAFKA_WRITE_TOPIC!,
      messages: [{ value: msg }],
    });
    // console.log(`Successfully wrote Kafka message to topic ${process.env.KAFKA_WRITE_TOPIC}: ${msg}`);
  } catch (err) {
    console.error(`Failed to write Kafka message to topic ${process.env.KAFKA_WRITE_TOPIC}:`, err);
    throw err;
  }
}

type KafkaNotificationMessage = {
  eventName?: string;
  data?: {
    chatId?: string
    route?: string,
    userId?: number | string;
    title?: string;
    body?: string;
    image?: string;
  };
};

export function initKafkaNotificationReader() {
  initKafkaReader(async (rawMsg) => {
    let msg: KafkaNotificationMessage;

    try {
      msg = JSON.parse(rawMsg);
    } catch (err) {
      console.error('Kafka message is not valid JSON:', rawMsg);
      return;
    }

    switch (msg.eventName) {
      case 'SendUserNotification':
        await handleSendUserNotification(msg.data);
        break;
      default:
        console.log(`Unhandled Kafka eventName: ${msg.eventName}`);
        break;
    }
  });
}

async function handleSendUserNotification(data: KafkaNotificationMessage['data']) {
  const userIdRaw = data?.userId ?? '';
  const chatId = data?.chatId ?? '';
  const title = data?.title ?? '';
  const body = data?.body ?? '';
  const image = normalizeImageUrl(data?.image) ?? '';
  const route = data?.route ?? '';

  const userId = typeof userIdRaw === 'string' ? Number(userIdRaw) : userIdRaw;
  if (!userId || Number.isNaN(userId)) {
    console.error('SendUserNotification missing or invalid userId:', userIdRaw);
    return;
  }
  if (!title || !body) {
    console.error('SendUserNotification missing title/body:', { title, body });
    return;
  }

  let tokens: string[] = [];
  try {
    tokens = await getTokensByUserId(userId);
  } catch (err) {
    console.error('Failed to load tokens for user:', userId, err);
    return;
  }

  if (!tokens.length) {
    console.log(`No active tokens for userId=${userId}`);
    return;
  }

  const chunks = chunk(tokens, 500);
  const deadTokens: string[] = [];

  for (const part of chunks) {
    const resp = await fcm().sendEachForMulticast({
      tokens: part,
      data: {
        eventName: 'SendUserNotification',
        chatId: chatId,
        title: title,
        route: route,
        body: body,
        image: image,
      },
      android: { priority: 'high' }, // важно
    });

    resp.responses.forEach((r, idx) => {
      if (r.success) {
        console.log(`Kafka SendUserNotification sent: userId=${userId} token=${part[idx]}`);
      }
    });

    resp.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error?.code || '';
        console.error(
          `Kafka SendUserNotification failed: userId=${userId} token=${part[idx]} code=${code} message=${r.error?.message || ''}`
        );
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token')
        ) {
          deadTokens.push(part[idx]);
        }
      }
    });
  }

  if (deadTokens.length) {
    await Promise.all(deadTokens.map((t) => deleteToken(t)));
  }
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
