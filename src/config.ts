// Gap 7: YAML config support
// Load order: YAML (highest) → .env → defaults
// Set EXTRACTOR_CONFIG=path/to/config.yaml or use extractor.yaml in cwd

import { existsSync, readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import * as yaml from 'js-yaml';

type YamlConfig = {
  github?: { pat?: string };
  concurrency?: { repos?: number; files?: number };
  adapters?: {
    r2?: { accountId?: string; accessKeyId?: string; secretAccessKey?: string; bucket?: string };
    s3?: { region?: string; accessKeyId?: string; secretAccessKey?: string; bucket?: string };
    gdrive?: { clientEmail?: string; privateKey?: string; rootFolderId?: string };
    githubTarget?: { owner?: string; repo?: string; branch?: string };
    azure?: { connectionString?: string; container?: string };
  };
};

// 1. Load YAML into process.env (before dotenv so YAML takes priority)
const yamlPath = process.env.EXTRACTOR_CONFIG ?? 'extractor.yaml';
if (existsSync(yamlPath)) {
  try {
    const raw = yaml.load(readFileSync(yamlPath, 'utf8')) as YamlConfig;
    injectYaml(raw);
    console.log(`[config] Loaded YAML: ${yamlPath}`);
  } catch (e) {
    console.warn(`[config] Failed to parse YAML config: ${e}`);
  }
}

// 2. Fill remaining vars from .env (won't override what YAML already set)
dotenv.config();

function injectYaml(c: YamlConfig): void {
  const set = (key: string, val: string | undefined) => {
    if (val && !process.env[key]) process.env[key] = val;
  };
  set('GITHUB_PAT', c.github?.pat);
  set('REPO_CONCURRENCY', c.concurrency?.repos?.toString());
  set('FILE_CONCURRENCY', c.concurrency?.files?.toString());
  const a = c.adapters;
  if (a?.r2) {
    set('R2_ACCOUNT_ID', a.r2.accountId);
    set('R2_ACCESS_KEY_ID', a.r2.accessKeyId);
    set('R2_SECRET_ACCESS_KEY', a.r2.secretAccessKey);
    set('R2_BUCKET', a.r2.bucket);
  }
  if (a?.s3) {
    set('S3_REGION', a.s3.region);
    set('S3_ACCESS_KEY_ID', a.s3.accessKeyId);
    set('S3_SECRET_ACCESS_KEY', a.s3.secretAccessKey);
    set('S3_BUCKET', a.s3.bucket);
  }
  if (a?.gdrive) {
    set('GDRIVE_CLIENT_EMAIL', a.gdrive.clientEmail);
    set('GDRIVE_PRIVATE_KEY', a.gdrive.privateKey);
    set('GDRIVE_ROOT_FOLDER_ID', a.gdrive.rootFolderId);
  }
  if (a?.githubTarget) {
    set('GITHUB_TARGET_OWNER', a.githubTarget.owner);
    set('GITHUB_TARGET_REPO', a.githubTarget.repo);
    set('GITHUB_TARGET_BRANCH', a.githubTarget.branch);
  }
  if (a?.azure) {
    set('AZURE_CONNECTION_STRING', a.azure.connectionString);
    set('AZURE_CONTAINER', a.azure.container);
  }
}

function opt(key: string): string | undefined {
  return process.env[key] || undefined;
}

function allPresent(keys: string[]): boolean {
  return keys.every((k) => !!process.env[k]);
}

export const config = {
  github: {
    pat: process.env.GITHUB_PAT ?? '',
  },
  concurrency: {
    repos: parseInt(process.env.REPO_CONCURRENCY ?? '3'),
    files: parseInt(process.env.FILE_CONCURRENCY ?? '10'),
  },
  r2: allPresent(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'])
    ? {
        accountId: opt('R2_ACCOUNT_ID')!,
        accessKeyId: opt('R2_ACCESS_KEY_ID')!,
        secretAccessKey: opt('R2_SECRET_ACCESS_KEY')!,
        bucket: opt('R2_BUCKET')!,
      }
    : null,
  s3: allPresent(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'])
    ? {
        region: opt('S3_REGION') ?? 'us-east-1',
        accessKeyId: opt('S3_ACCESS_KEY_ID')!,
        secretAccessKey: opt('S3_SECRET_ACCESS_KEY')!,
        bucket: opt('S3_BUCKET')!,
      }
    : null,
  gdrive: allPresent(['GDRIVE_CLIENT_EMAIL', 'GDRIVE_PRIVATE_KEY', 'GDRIVE_ROOT_FOLDER_ID'])
    ? {
        clientEmail: opt('GDRIVE_CLIENT_EMAIL')!,
        privateKey: opt('GDRIVE_PRIVATE_KEY')!.replace(/\\n/g, '\n'),
        rootFolderId: opt('GDRIVE_ROOT_FOLDER_ID')!,
      }
    : null,
  githubTarget: allPresent(['GITHUB_TARGET_OWNER', 'GITHUB_TARGET_REPO'])
    ? {
        owner: opt('GITHUB_TARGET_OWNER')!,
        repo: opt('GITHUB_TARGET_REPO')!,
        branch: opt('GITHUB_TARGET_BRANCH') ?? 'main',
      }
    : null,
  azure: allPresent(['AZURE_CONNECTION_STRING', 'AZURE_CONTAINER'])
    ? {
        connectionString: opt('AZURE_CONNECTION_STRING')!,
        container: opt('AZURE_CONTAINER')!,
      }
    : null,
};
