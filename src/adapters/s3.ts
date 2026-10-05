import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { StorageAdapter } from './base.js';

type S3Config = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export class S3Adapter implements StorageAdapter {
  readonly name = 's3';
  private client: S3Client;
  private bucket: string;

  constructor(cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    this.bucket = cfg.bucket;
  }

  async upload(storagePath: string, content: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storagePath,
        Body: content,
        ContentType: contentType,
      })
    );
  }
}
