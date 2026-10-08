import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createHash } from 'crypto';
import {
  normalizeStorageError,
  preflightFailure,
  type DurableStorageAdapter,
  type StorageHeadResult,
  type StoragePreflightResult,
} from './base';

export class S3Adapter implements DurableStorageAdapter {
  readonly name = 's3';
  private client: S3Client;
  private bucket: string;

  constructor(cfg: { region: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
    this.client = new S3Client({
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    this.bucket = cfg.bucket;
  }

  async upload(storagePath: string, content: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: storagePath, Body: content, ContentType: contentType,
      }));
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'upload');
    }
  }

  async uploadOptimistic(storagePath: string, content: Buffer, contentType: string, ifMatchEtag?: string): Promise<{ etag: string }> {
    try {
      const result = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: storagePath, Body: content, ContentType: contentType,
        IfMatch: ifMatchEtag,
      }));
      return { etag: result.ETag! };
    } catch (error) {
      const err = error as any;
      if (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412) {
        throw new Error(`OptimisticLockingFailed: The ETag did not match for ${storagePath}`);
      }
      throw normalizeStorageError(error, this.name, 'uploadOptimistic');
    }
  }

  async uploadStream(storagePath: string, stream: NodeJS.ReadableStream | AsyncIterable<Buffer>, contentType: string): Promise<{ size: number, sha256: string }> {
    try {
      let size = 0;
      const hash = createHash('sha256');
      
      // We must tee or intercept the stream to calculate sha256 and size
      const passThrough = new (require('stream').PassThrough)();
      
      const pump = async () => {
        for await (const chunk of stream) {
          size += chunk.length;
          hash.update(chunk);
          if (!passThrough.write(chunk)) {
            await new Promise(r => passThrough.once('drain', r));
          }
        }
        passThrough.end();
      };
      
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: storagePath,
          Body: passThrough,
          ContentType: contentType,
        },
      });

      const [res] = await Promise.all([upload.done(), pump()]);
      return { size, sha256: hash.digest('hex') };
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'uploadStream');
    }
  }

  async download(storagePath: string): Promise<{ content: Buffer, etag?: string }> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storagePath }));
      const content = await bodyToBuffer(result.Body);
      return { content, etag: result.ETag };
    } catch (error) {
      const err = error as any;
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        throw new Error(`NotFound: The key ${storagePath} does not exist`);
      }
      throw normalizeStorageError(error, this.name, 'download');
    }
  }

  async preflight(options?: { requireOverwrite?: boolean }): Promise<StoragePreflightResult> {
    const key = `.detiq/preflight-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
    let versioning: boolean | undefined;

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      try {
        const versioningResult = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket }));
        versioning = versioningResult.Status === 'Enabled';
      } catch {
        versioning = undefined;
      }

      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from('detiq-preflight'),
        ContentType: 'text/plain',
      }));
      
      if (options?.requireOverwrite) {
        try {
          await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: Buffer.from('detiq-preflight-overwrite'),
            ContentType: 'text/plain',
          }));
        } catch (err: any) {
          if (err.message?.includes('locked') || err.message?.includes('policy') || err.name === 'MethodNotAllowed' || err.$metadata?.httpStatusCode === 403 || err.$metadata?.httpStatusCode === 405) {
            throw new Error('Bucket Object Lock (WORM) prevents overwriting files. Run state cannot be stored here.');
          }
          throw err;
        }
      }
      
      await this.delete(key);

      return {
        adapter: this.name,
        writable: true,
        versioning,
        message: versioning === false ? 'Bucket is writable, but versioning is not enabled.' : 'Bucket is writable and allows overwriting (no Object Lock).',
      };
    } catch (error) {
      return preflightFailure(this.name, error);
    }
  }

  async head(storagePath: string): Promise<StorageHeadResult> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storagePath }));
      return {
        exists: true,
        size: result.ContentLength,
        etag: result.ETag,
        versionId: result.VersionId,
      };
    } catch (error) {
      const normalized = normalizeStorageError(error, this.name, 'head');
      if (normalized.httpStatus === 404 || normalized.code === 'NoSuchKey') return { exists: false };
      throw normalized;
    }
  }

  async verify(storagePath: string, sha256: string): Promise<void> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storagePath }));
      const content = await bodyToBuffer(result.Body);
      const actual = createHash('sha256').update(content).digest('hex');
      if (actual !== sha256) {
        throw new Error(`Checksum mismatch for ${storagePath}: expected ${sha256}, got ${actual}`);
      }
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'verify');
    }
  }

  async delete(storagePath: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storagePath }));
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'delete');
    }
  }
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
