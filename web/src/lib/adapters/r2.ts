import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { StorageAdapter } from './base';

export class R2Adapter implements StorageAdapter {
  readonly name = 'r2';
  private client: S3Client;
  private bucket: string;

  constructor(cfg: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    this.bucket = cfg.bucket;
  }

  async upload(storagePath: string, content: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: storagePath, Body: content, ContentType: contentType,
    }));
  }
}
