import { BlobServiceClient } from '@azure/storage-blob';
import type { StorageAdapter } from './base.js';

type AzureConfig = {
  connectionString: string;
  container: string;
};

export class AzureAdapter implements StorageAdapter {
  readonly name = 'azure';
  private client: BlobServiceClient;
  private container: string;

  constructor(cfg: AzureConfig) {
    this.client = BlobServiceClient.fromConnectionString(cfg.connectionString);
    this.container = cfg.container;
  }

  async upload(storagePath: string, content: Buffer, contentType: string): Promise<void> {
    const containerClient = this.client.getContainerClient(this.container);
    await containerClient.createIfNotExists();
    const blobClient = containerClient.getBlockBlobClient(storagePath);
    await blobClient.upload(content, content.length, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  }
}
