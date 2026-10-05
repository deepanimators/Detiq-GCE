import { google, drive_v3 } from 'googleapis';
import type { StorageAdapter } from './base.js';
import { Readable } from 'stream';
import { withRetry } from '../retry.js';

type GDriveConfig = {
  clientEmail: string;
  privateKey: string;
  rootFolderId: string;
};

export class GDriveAdapter implements StorageAdapter {
  readonly name = 'gdrive';
  private drive: drive_v3.Drive;
  private rootFolderId: string;
  // Maps path → in-flight promise — prevents concurrent duplicate folder creation
  private folderPromises = new Map<string, Promise<string>>();

  constructor(cfg: GDriveConfig) {
    const auth = new google.auth.JWT({
      email: cfg.clientEmail,
      key: cfg.privateKey,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    this.drive = google.drive({ version: 'v3', auth });
    this.rootFolderId = cfg.rootFolderId;
  }

  async upload(storagePath: string, content: Buffer, contentType: string): Promise<void> {
    const parts = storagePath.split('/');
    const fileName = parts.pop()!;
    const parentId = await this.ensureFolderPath(parts);

    await withRetry(
      () =>
        this.drive.files.create({
          requestBody: { name: fileName, parents: [parentId] },
          media: { mimeType: contentType, body: Readable.from(content) },
          fields: 'id',
        }),
      { label: `gdrive upload ${storagePath}` }
    );
  }

  private ensureFolderPath(parts: string[]): Promise<string> {
    return this._buildPath(parts, 0, this.rootFolderId, '');
  }

  private async _buildPath(
    parts: string[],
    idx: number,
    parentId: string,
    pathSoFar: string
  ): Promise<string> {
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
      () =>
        this.drive.files.list({
          q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id)',
          pageSize: 1,
        }),
      { label: `gdrive findFolder ${key}` }
    );

    if (res.data.files?.length) {
      return res.data.files[0].id!;
    }

    const created = await withRetry(
      () =>
        this.drive.files.create({
          requestBody: {
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
          },
          fields: 'id',
        }),
      { label: `gdrive createFolder ${key}` }
    );

    return created.data.id!;
  }
}
