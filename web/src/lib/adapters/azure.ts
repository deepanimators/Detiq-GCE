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
