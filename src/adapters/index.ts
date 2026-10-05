import type { StorageAdapter } from './base.js';
import { R2Adapter } from './r2.js';
import { S3Adapter } from './s3.js';
import { GDriveAdapter } from './gdrive.js';
import { GitHubTargetAdapter } from './github-target.js';
import { AzureAdapter } from './azure.js';
import { config } from '../config.js';

export function buildAdapters(): StorageAdapter[] {
  const adapters: StorageAdapter[] = [];

  if (config.r2) {
    adapters.push(new R2Adapter(config.r2));
    console.log('[adapter] R2 enabled');
  }
  if (config.s3) {
    adapters.push(new S3Adapter(config.s3));
    console.log('[adapter] S3 enabled');
  }
  if (config.gdrive) {
    adapters.push(new GDriveAdapter(config.gdrive));
    console.log('[adapter] Google Drive enabled');
  }
  if (config.githubTarget) {
    adapters.push(
      new GitHubTargetAdapter({ ...config.githubTarget, pat: config.github.pat })
    );
    console.log('[adapter] GitHub target enabled');
  }
  if (config.azure) {
    adapters.push(new AzureAdapter(config.azure));
    console.log('[adapter] Azure Blob enabled');
  }

  if (adapters.length === 0) {
    throw new Error('No storage adapters configured. Check .env file.');
  }

  return adapters;
}

export type { StorageAdapter };
