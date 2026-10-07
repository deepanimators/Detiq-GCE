import { BlobServiceClient } from '@azure/storage-blob';
import { createHash } from 'crypto';
import {
  normalizeStorageError,
  preflightFailure,
  type DurableStorageAdapter,
  type StorageHeadResult,
  type StoragePreflightResult,
} from './base';

export class AzureAdapter implements DurableStorageAdapter {
  readonly name = 'azure';
  private client: BlobServiceClient;
  private container: string;

  constructor(cfg: { connectionString: string; container: string }) {
    this.client = BlobServiceClient.fromConnectionString(cfg.connectionString);
    this.container = cfg.container;
  }

  async upload(storagePath: string, content: Buffer, contentType: string): Promise<void> {
    try {
      const cc = this.client.getContainerClient(this.container);
      await cc.createIfNotExists();
      await cc.getBlockBlobClient(storagePath).upload(content, content.length, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'upload');
    }
  }

  async uploadOptimistic(storagePath: string, content: Buffer, contentType: string, ifMatchEtag?: string): Promise<{ etag: string }> {
    try {
      const cc = this.client.getContainerClient(this.container);
      await cc.createIfNotExists();
      const options: any = {
        blobHTTPHeaders: { blobContentType: contentType },
      };
      if (ifMatchEtag) {
        options.conditions = { ifMatch: ifMatchEtag };
      } else if (ifMatchEtag === '') { // if match empty, fail if exists
        options.conditions = { ifNoneMatch: '*' };
      }
      
      const result = await cc.getBlockBlobClient(storagePath).upload(content, content.length, options);
      return { etag: result.etag! };
    } catch (error) {
      const err = error as any;
      if (err.statusCode === 412 || err.details?.errorCode === 'ConditionNotMet' || err.details?.errorCode === 'BlobAlreadyExists') {
        throw new Error(`OptimisticLockingFailed: The ETag did not match for ${storagePath}`);
      }
      throw normalizeStorageError(error, this.name, 'uploadOptimistic');
    }
  }

  async uploadStream(storagePath: string, stream: NodeJS.ReadableStream | AsyncIterable<Buffer>, contentType: string): Promise<{ size: number, sha256: string }> {
    try {
      const cc = this.client.getContainerClient(this.container);
      await cc.createIfNotExists();
      
      let size = 0;
      const hash = createHash('sha256');
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
      
      const upload = cc.getBlockBlobClient(storagePath).uploadStream(passThrough, undefined, undefined, {
        blobHTTPHeaders: { blobContentType: contentType }
      });

      await Promise.all([upload, pump()]);
      return { size, sha256: hash.digest('hex') };
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'uploadStream');
    }
  }

  async download(storagePath: string): Promise<{ content: Buffer, etag?: string }> {
    try {
      const blob = this.client.getContainerClient(this.container).getBlockBlobClient(storagePath);
      const props = await blob.getProperties();
      const content = await blob.downloadToBuffer();
      return { content, etag: props.etag };
    } catch (error) {
      const err = error as any;
      if (err.statusCode === 404 || err.details?.errorCode === 'BlobNotFound') {
        throw new Error(`NotFound: The key ${storagePath} does not exist`);
      }
      throw normalizeStorageError(error, this.name, 'download');
    }
  }

  async preflight(): Promise<StoragePreflightResult> {
    const key = `.detiq/preflight-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
    try {
      const cc = this.client.getContainerClient(this.container);
      await cc.createIfNotExists();
      await cc.getBlockBlobClient(key).uploadData(Buffer.from('detiq-preflight'), {
        blobHTTPHeaders: { blobContentType: 'text/plain' },
      });
      await this.delete(key);

      return {
        adapter: this.name,
        writable: true,
        versioning: undefined,
        message: 'Container is writable. Configure immutability policies where compliance requires object lock.',
      };
    } catch (error) {
      return preflightFailure(this.name, error);
    }
  }

  async head(storagePath: string): Promise<StorageHeadResult> {
    try {
      const blob = this.client.getContainerClient(this.container).getBlockBlobClient(storagePath);
      const exists = await blob.exists();
      if (!exists) return { exists: false };
      const props = await blob.getProperties();
      return {
        exists: true,
        size: props.contentLength,
        etag: props.etag,
        versionId: props.versionId,
      };
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'head');
    }
  }

  async verify(storagePath: string, sha256: string): Promise<void> {
    try {
      const blob = this.client.getContainerClient(this.container).getBlockBlobClient(storagePath);
      const content = await blob.downloadToBuffer();
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
      const blob = this.client.getContainerClient(this.container).getBlockBlobClient(storagePath);
      await blob.deleteIfExists();
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'delete');
    }
  }
}
