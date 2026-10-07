import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type RunObjectStoreConfig = {
  client: S3Client;
  bucket: string;
  prefix: string;
};

export function getRunObjectStore(): RunObjectStoreConfig {
  const r2 = process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
    ? {
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        region: 'auto',
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        bucket: process.env.R2_BUCKET,
      }
    : null;

  const s3 = process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY &&
    process.env.S3_BUCKET
    ? {
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION ?? 'us-east-1',
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        bucket: process.env.S3_BUCKET,
      }
    : null;

  const config = r2 ?? s3;
  if (!config) {
    throw new Error(
      'Durable object storage is not configured. Set the R2_* or S3_* storage variables in Vercel.'
    );
  }

  return {
    client: new S3Client({
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
    bucket: config.bucket,
    prefix: (process.env.RUN_STORE_KEY_PREFIX ?? 'detiq').replace(/^\/+|\/+$/g, ''),
  };
}

export async function putRunObject(key: string, body: string): Promise<void> {
  const store = getRunObjectStore();
  await store.client.send(new PutObjectCommand({
    Bucket: store.bucket,
    Key: `${store.prefix}/${key}`,
    Body: body,
    ContentType: 'application/json',
  }));
}

export async function getRunObject(key: string): Promise<string | null> {
  const store = getRunObjectStore();
  try {
    const result = await store.client.send(new GetObjectCommand({
      Bucket: store.bucket,
      Key: `${store.prefix}/${key}`,
    }));
    return result.Body ? result.Body.transformToString() : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function deleteRunObject(key: string): Promise<void> {
  const store = getRunObjectStore();
  await store.client.send(new DeleteObjectCommand({
    Bucket: store.bucket,
    Key: `${store.prefix}/${key}`,
  }));
}

export async function listRunObjects(prefix: string): Promise<string[]> {
  const store = getRunObjectStore();
  const result = await store.client.send(new ListObjectsV2Command({
    Bucket: store.bucket,
    Prefix: `${store.prefix}/${prefix}`,
  }));
  return (result.Contents ?? [])
    .map((item) => item.Key)
    .filter((key): key is string => Boolean(key))
    .map((key) => key.slice(`${store.prefix}/`.length));
}

export async function checkRunObjectStore(): Promise<void> {
  const store = getRunObjectStore();
  await store.client.send(new HeadBucketCommand({ Bucket: store.bucket }));
}

function isNotFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.$metadata?.httpStatusCode === 404 ||
    value.name === 'NoSuchKey' ||
    value.name === 'NotFound';
}
