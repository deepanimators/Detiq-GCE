import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { withRetry } from '@/lib/retry';
import {
  normalizeStorageError,
  preflightFailure,
  type DurableStorageAdapter,
  type StorageHeadResult,
  type StoragePreflightResult,
} from './base';

export class GDriveAdapter implements DurableStorageAdapter {
  readonly name = 'gdrive';
  private drive: drive_v3.Drive;
  private rootFolderId: string;
  private folderPromises = new Map<string, Promise<string>>();

  constructor(cfg: { clientEmail: string; privateKey: string; rootFolderId: string }) {
    const auth = new google.auth.JWT({
      email: cfg.clientEmail,
      key: cfg.privateKey,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    this.drive = google.drive({ version: 'v3', auth });
    this.rootFolderId = cfg.rootFolderId;
  }

  
  async uploadStream(storagePath: string, stream: NodeJS.ReadableStream | AsyncIterable<Buffer>, contentType: string): Promise<{ size: number, sha256: string }> {
    const { PassThrough } = require('stream');
    const crypto = require('crypto');
    const passThrough = new PassThrough();
    let size = 0;
    const hash = crypto.createHash('sha256');
    
    const pump = async () => {
      for await (const chunk of stream) {
        size += chunk.length;
        hash.update(chunk as Buffer);
        if (!passThrough.write(chunk)) {
          await new Promise(r => passThrough.once('drain', r));
        }
      }
      passThrough.end();
    };

    const parts = storagePath.split('/');
    const fileName = parts.pop()!;
    const parentId = await this._buildPath(parts, 0, this.rootFolderId, '');

    const [res] = await Promise.all([
      withRetry(
        () => this.drive.files.create({
          requestBody: { name: fileName, parents: [parentId] },
          media: { mimeType: contentType, body: passThrough },
          fields: 'id',
        }),
        { label: `gdrive uploadStream ${storagePath}` }
      ),
      pump()
    ]);

    return { size, sha256: hash.digest('hex') };
  }

  async upload(storagePath: string, content: Buffer, contentType: string): Promise<void> {
    try {
      const parts = storagePath.split('/');
      const fileName = parts.pop()!;
      const parentId = await this._buildPath(parts, 0, this.rootFolderId, '');

      await withRetry(
        () => this.drive.files.create({
          requestBody: { name: fileName, parents: [parentId] },
          media: { mimeType: contentType, body: Readable.from(content) },
          fields: 'id',
        }),
        { label: `gdrive upload ${storagePath}` }
      );
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'upload');
    }
  }

  async preflight(): Promise<StoragePreflightResult> {
    let fileId: string | undefined;
    try {
      await this.drive.files.get({ fileId: this.rootFolderId, fields: 'id,name,mimeType' });
      const created = await this.drive.files.create({
        requestBody: {
          name: `.detiq-preflight-${Date.now()}.txt`,
          parents: [this.rootFolderId],
        },
        media: { mimeType: 'text/plain', body: Readable.from(Buffer.from('detiq-preflight')) },
        fields: 'id',
      });
      fileId = created.data.id ?? undefined;
      if (fileId) await this.drive.files.delete({ fileId });

      return {
        adapter: this.name,
        writable: true,
        versioning: false,
        message: 'Drive folder is writable. Use object storage for large compliance backups.',
      };
    } catch (error) {
      if (fileId) {
        try {
          await this.drive.files.delete({ fileId });
        } catch {
          // Best-effort cleanup only.
        }
      }
      return preflightFailure(this.name, error);
    }
  }

  async head(storagePath: string): Promise<StorageHeadResult> {
    try {
      const file = await this.findFileByPath(storagePath);
      if (!file?.id) return { exists: false };
      return {
        exists: true,
        size: file.size ? Number(file.size) : undefined,
        etag: file.md5Checksum ?? undefined,
      };
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'head');
    }
  }

  async verify(storagePath: string, sha256: string): Promise<void> {
    try {
      const file = await this.findFileByPath(storagePath);
      if (!file?.id) throw new Error(`File does not exist: ${storagePath}`);
      const result = await this.drive.files.get(
        { fileId: file.id, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      const actual = createHash('sha256').update(Buffer.from(result.data as ArrayBuffer)).digest('hex');
      if (actual !== sha256) {
        throw new Error(`Checksum mismatch for ${storagePath}: expected ${sha256}, got ${actual}`);
      }
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'verify');
    }
  }

  async delete(storagePath: string): Promise<void> {
    try {
      const file = await this.findFileByPath(storagePath);
      if (file?.id) await this.drive.files.delete({ fileId: file.id });
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'delete');
    }
  }

  private async _buildPath(parts: string[], idx: number, parentId: string, pathSoFar: string): Promise<string> {
    if (idx >= parts.length) return parentId;
    const part = parts[idx];
    const key = `${pathSoFar}/${part}`;
    if (!this.folderPromises.has(key)) {
      this.folderPromises.set(key, this._findOrCreate(part, parentId, key));
    }
    const folderId = await this.folderPromises.get(key)!;
    return this._buildPath(parts, idx + 1, folderId, key);
  }

  private async _findOrCreate(name: string, parentId: string, key: string): Promise<string> {
    const res = await withRetry(
      () => this.drive.files.list({
        q: `name='${escapeDriveQuery(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)', pageSize: 1,
      }),
      { label: `gdrive findFolder ${key}` }
    );
    if (res.data.files?.length) return res.data.files[0].id!;

    const created = await withRetry(
      () => this.drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
        fields: 'id',
      }),
      { label: `gdrive createFolder ${key}` }
    );
    return created.data.id!;
  }

  private async findFileByPath(storagePath: string): Promise<drive_v3.Schema$File | null> {
    const parts = storagePath.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return null;

    let parentId = this.rootFolderId;
    for (const folderName of parts) {
      const res = await this.drive.files.list({
        q: `name='${escapeDriveQuery(folderName)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
        pageSize: 1,
      });
      const folderId = res.data.files?.[0]?.id;
      if (!folderId) return null;
      parentId = folderId;
    }

    const res = await this.drive.files.list({
      q: `name='${escapeDriveQuery(fileName)}' and '${parentId}' in parents and trashed=false`,
      fields: 'files(id,size,md5Checksum)',
      pageSize: 1,
    });

    return res.data.files?.[0] ?? null;
  }
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
