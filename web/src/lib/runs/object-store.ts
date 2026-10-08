import { R2Adapter } from '@/lib/adapters/r2';
import { S3Adapter } from '@/lib/adapters/s3';
import { type DurableStorageAdapter, isDurableStorageAdapter, normalizeStorageError } from '@/lib/adapters/base';

export class RunObjectStoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunObjectStoreConfigurationError';
  }
}

export function getPlatformStorageAdapter(): DurableStorageAdapter {
  const r2 = process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET
    ? new R2Adapter({
        accountId: process.env.R2_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        bucket: process.env.R2_BUCKET,
      })
    : null;

  const s3 = process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY && process.env.S3_BUCKET
    ? new S3Adapter({
        region: process.env.S3_REGION ?? 'us-east-1',
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        bucket: process.env.S3_BUCKET,
      })
    : null;

  const adapter = r2 ?? s3;
  if (!adapter || !isDurableStorageAdapter(adapter)) {
    throw new RunObjectStoreConfigurationError(
      'Durable object storage is not configured. Set the R2_* or S3_* storage variables in Vercel.'
    );
  }

  return adapter;
}

export function getPlatformPrefix(): string {
  return (process.env.RUN_STORE_KEY_PREFIX ?? 'detiq').replace(/^\/+|\/+$/g, '');
}

export async function putRunObject(key: string, body: string): Promise<void> {
  const adapter = getPlatformStorageAdapter();
  await adapter.upload(`${getPlatformPrefix()}/${key}`, Buffer.from(body), 'application/json');
}

export async function putRunObjectOptimistic(key: string, body: string, ifMatchEtag?: string): Promise<{ etag: string }> {
  const adapter = getPlatformStorageAdapter();
  if (!adapter.uploadOptimistic) {
     throw new Error(`Adapter ${adapter.name} does not support optimistic uploads`);
  }
  return await adapter.uploadOptimistic(`${getPlatformPrefix()}/${key}`, Buffer.from(body), 'application/json', ifMatchEtag);
}

export async function getRunObjectWithEtag(key: string): Promise<{ body: string, etag: string } | null> {
  const adapter = getPlatformStorageAdapter();
  if (!adapter.download) {
     throw new Error(`Adapter ${adapter.name} does not support downloads`);
  }
  try {
    const { content, etag } = await adapter.download(`${getPlatformPrefix()}/${key}`);
    return { body: content.toString('utf8'), etag: etag ?? '' };
  } catch (error: any) {
    if (
      error.code === 'NoSuchKey' ||
      error.code === 'NotFound' ||
      error.httpStatus === 404 ||
      (error.message && error.message.includes('NotFound'))
    ) {
      return null;
    }
    throw error;
  }
}

export async function getRunObject(key: string): Promise<string | null> {
  const res = await getRunObjectWithEtag(key);
  return res ? res.body : null;
}

export async function deleteRunObject(key: string): Promise<void> {
  const adapter = getPlatformStorageAdapter();
  if (!adapter.delete) {
     throw new Error(`Adapter ${adapter.name} does not support deletes`);
  }
  await adapter.delete(`${getPlatformPrefix()}/${key}`);
}

export async function checkRunObjectStore(): Promise<void> {
  const adapter = getPlatformStorageAdapter();
  await adapter.preflight({ requireOverwrite: true });
}

