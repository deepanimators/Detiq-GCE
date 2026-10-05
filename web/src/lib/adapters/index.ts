import { R2Adapter } from './r2';
import { S3Adapter } from './s3';
import { GDriveAdapter } from './gdrive';
import { GitHubTargetAdapter } from './github-target';
import { AzureAdapter } from './azure';

export type { StorageAdapter } from './base';

export type AdapterConfig = {
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  s3?: { region: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  gdrive?: { clientEmail: string; privateKey: string; rootFolderId: string };
  githubTarget?: { owner: string; repo: string; branch?: string; pat: string };
  azure?: { connectionString: string; container: string };
};

export function buildAdaptersFromConfig(cfg: AdapterConfig) {
  const adapters = [];
  if (cfg.r2) adapters.push(new R2Adapter(cfg.r2));
  if (cfg.s3) adapters.push(new S3Adapter(cfg.s3));
  if (cfg.gdrive) adapters.push(new GDriveAdapter(cfg.gdrive));
  if (cfg.githubTarget) adapters.push(new GitHubTargetAdapter(cfg.githubTarget));
  if (cfg.azure) adapters.push(new AzureAdapter(cfg.azure));
  return adapters;
}

export function buildAdaptersFromEnv(): ReturnType<typeof buildAdaptersFromConfig> {
  const cfg: AdapterConfig = {};

  if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET) {
    cfg.r2 = {
      accountId: process.env.R2_ACCOUNT_ID,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      bucket: process.env.R2_BUCKET,
    };
  }
  if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY && process.env.S3_BUCKET) {
    cfg.s3 = {
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      bucket: process.env.S3_BUCKET,
    };
  }
  if (process.env.GDRIVE_CLIENT_EMAIL && process.env.GDRIVE_PRIVATE_KEY && process.env.GDRIVE_ROOT_FOLDER_ID) {
    cfg.gdrive = {
      clientEmail: process.env.GDRIVE_CLIENT_EMAIL,
      privateKey: process.env.GDRIVE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      rootFolderId: process.env.GDRIVE_ROOT_FOLDER_ID,
    };
  }
  if (process.env.GITHUB_TARGET_OWNER && process.env.GITHUB_TARGET_REPO && process.env.GITHUB_PAT) {
    cfg.githubTarget = {
      owner: process.env.GITHUB_TARGET_OWNER,
      repo: process.env.GITHUB_TARGET_REPO,
      branch: process.env.GITHUB_TARGET_BRANCH ?? 'main',
      pat: process.env.GITHUB_PAT,
    };
  }
  if (process.env.AZURE_CONNECTION_STRING && process.env.AZURE_CONTAINER) {
    cfg.azure = {
      connectionString: process.env.AZURE_CONNECTION_STRING,
      container: process.env.AZURE_CONTAINER,
    };
  }

  return buildAdaptersFromConfig(cfg);
}
