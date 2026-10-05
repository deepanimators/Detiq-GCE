export interface StorageAdapter {
  readonly name: string;
  upload(storagePath: string, content: Buffer, contentType: string): Promise<void>;
}
