import { BlobServiceClient } from '@azure/storage-blob';
import type { StorageAdapter } from './base';

export class AzureAdapter implements StorageAdapter {
  readonly name = 'azure';
  private client: BlobServiceClient;
  private container: string;

  constructor(cfg: { connectionString: string; container: string }) {
    this.client = BlobServiceClient.fromConnectionString(cfg.connectionString);
    this.container = cfg.container;
  }

  async upload(storagePath: string, content: Buffer, contentType: string): Promise<void> {
    const cc = this.client.getContainerClient(this.container);
    await cc.createIfNotExists();
    await cc.getBlockBlobClient(storagePath).upload(content, content.length, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  }
}
