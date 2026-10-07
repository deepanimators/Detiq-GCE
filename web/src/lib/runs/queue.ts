import crypto from 'crypto';
import type { QueuedRun } from './types';

const QUEUE_NAME = 'runs';
const PROCESSING_QUEUE_NAME = 'runs:processing';

export class RunQueueConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunQueueConfigurationError';
  }
}

type RedisValue = string | number | null;

function redisConfig(): { url: string; token: string; prefix: string; key: string } {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new RunQueueConfigurationError(
      'Durable run queue is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.'
    );
  }
  const prefix = process.env.RUN_STORE_KEY_PREFIX ?? 'detiq:runs';
  return { url, token, prefix, key: `${prefix}:${QUEUE_NAME}` };
}

async function redisCommand(command: RedisValue[]): Promise<RedisValue> {
  const { url, token } = redisConfig();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Run queue Redis request failed with HTTP ${response.status}.`);
  }
  const result = (await response.json()) as { result?: RedisValue; error?: string };
  if (result.error) throw new Error(`Run queue Redis error: ${result.error}`);
  return result.result ?? null;
}

function encryptionKey(): Buffer {
  const secret = process.env.RUN_QUEUE_ENCRYPTION_KEY;
  if (!secret) {
    throw new RunQueueConfigurationError(
      'Durable run queue encryption is not configured. Set RUN_QUEUE_ENCRYPTION_KEY.'
    );
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(value: QueuedRun): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decrypt(value: string): QueuedRun {
  const [ivValue, tagValue, ciphertextValue] = value.split('.');
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error('Invalid queued run payload.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivValue, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  ) as QueuedRun;
}

export function isDurableRunQueueConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL &&
      process.env.UPSTASH_REDIS_REST_TOKEN &&
      process.env.RUN_QUEUE_ENCRYPTION_KEY
  );
}

export async function enqueueRun(job: QueuedRun): Promise<void> {
  const { key } = redisConfig();
  await redisCommand(['LPUSH', key, encrypt(job)]);
}

export async function claimRun(): Promise<{ job: QueuedRun; token: string } | null> {
  const { prefix, key } = redisConfig();
  const processingKey = `${prefix}:${PROCESSING_QUEUE_NAME}`;
  const value = await redisCommand(['RPOPLPUSH', key, processingKey]);
  return typeof value === 'string' ? { job: decrypt(value), token: value } : null;
}

export async function acknowledgeRun(token: string): Promise<void> {
  const { prefix } = redisConfig();
  await redisCommand(['LREM', `${prefix}:${PROCESSING_QUEUE_NAME}`, '1', token]);
}
