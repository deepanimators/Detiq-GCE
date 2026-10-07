import crypto from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { QueuedRun } from './types';
import {
  deleteRunObject,
  getRunObject,
  getRunObjectStore,
  listRunObjects,
  putRunObject,
} from './object-store';

type ClaimLease = {
  claimedAt: string;
  leaseExpiresAt: string;
};

export class RunQueueConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunQueueConfigurationError';
  }
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
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
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
    process.env.RUN_QUEUE_ENCRYPTION_KEY &&
      (process.env.R2_BUCKET || process.env.S3_BUCKET)
  );
}

export async function enqueueRun(job: QueuedRun): Promise<void> {
  await putRunObject(`queue/queued/${job.runId}.json`, encrypt(job));
}

export async function claimRun(): Promise<{ job: QueuedRun; token: string } | null> {
  const queued = await listRunObjects('queue/queued/');
  for (const token of queued) {
    const runId = token.split('/').at(-1)?.replace(/\.json$/, '');
    if (!runId) continue;
    const claimKey = `queue/claimed/${runId}.json`;

    try {
      await deleteExpiredClaim(claimKey);
      const store = getRunObjectStore();
      const now = Date.now();
      await store.client.send(new PutObjectCommand({
        Bucket: store.bucket,
        Key: `${store.prefix}/${claimKey}`,
        Body: JSON.stringify({
          claimedAt: new Date(now).toISOString(),
          leaseExpiresAt: new Date(now + claimLeaseMs()).toISOString(),
        } satisfies ClaimLease),
        ContentType: 'application/json',
        IfNoneMatch: '*',
      }));
      const value = await getRunObject(token);
      if (!value) {
        await deleteRunObject(claimKey);
        continue;
      }
      return { job: decrypt(value), token };
    } catch (error) {
      if (isAlreadyClaimed(error)) continue;
      throw error;
    }
  }
  return null;
}

export async function acknowledgeRun(token: string): Promise<void> {
  const runId = token.split('/').at(-1)?.replace(/\.json$/, '');
  if (!runId) throw new Error('Invalid queued run token.');
  await deleteRunObject(token);
  await deleteRunObject(`queue/claimed/${runId}.json`);
}

async function deleteExpiredClaim(claimKey: string): Promise<void> {
  const raw = await getRunObject(claimKey);
  if (!raw) return;

  try {
    const lease = JSON.parse(raw) as Partial<ClaimLease>;
    if (!lease.leaseExpiresAt || Date.parse(lease.leaseExpiresAt) > Date.now()) return;
  } catch {
    return;
  }

  await deleteRunObject(claimKey);
}

function claimLeaseMs(): number {
  const configuredSeconds = Number(process.env.RUN_QUEUE_LEASE_SECONDS ?? 900);
  const seconds = Number.isFinite(configuredSeconds) && configuredSeconds > 0
    ? configuredSeconds
    : 900;
  return seconds * 1000;
}

function isAlreadyClaimed(error: unknown): boolean {
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: string };
  return value.$metadata?.httpStatusCode === 412 || value.name === 'PreconditionFailed';
}
