// Gap 1: Git history — full clone and git bundle modes
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pLimit from 'p-limit';
import type { StorageAdapter } from './adapters/index.js';
import { getMimeType } from './mime.js';
import { logger } from './logger.js';

export type CloneMode = 'shallow' | 'full' | 'bundle';

type CloneResult = { uploaded: number; failed: number };

export async function cloneAndUpload(opts: {
  owner: string;
  repo: string;
  defaultBranch: string;
  pat: string;
  adapters: StorageAdapter[];
  fileConcurrency: number;
  mode: CloneMode;
  dryRun?: boolean;
  onFile?: () => void;
}): Promise<CloneResult> {
  const { owner, repo, pat, adapters, fileConcurrency, mode, dryRun = false } = opts;
  const repoUrl = `https://${pat}@github.com/${owner}/${repo}.git`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `github-extractor-${owner}-${repo}-`));

  try {
    const git = simpleGit();

    if (mode === 'bundle') {
      return await bundleMode({ git, repoUrl, tmpDir, owner, repo, adapters, dryRun });
    }

    const cloneArgs = mode === 'shallow' ? ['--depth', '1'] : [];
    logger.debug(`Cloning ${owner}/${repo} (${mode}) to temp dir`);
    await git.clone(repoUrl, tmpDir, cloneArgs);

    const files = walkDir(tmpDir);
    logger.info(`  ${files.length} files in clone of ${owner}/${repo}`);

    if (dryRun) return { uploaded: files.length, failed: 0 };

    const fileLimit = pLimit(fileConcurrency);
    let uploaded = 0;
    let failed = 0;

    const results = await Promise.allSettled(
      files.map((absPath) =>
        fileLimit(async () => {
          const relativePath = path.relative(tmpDir, absPath).replace(/\\/g, '/');
          const storagePath = `${owner}/${repo}/${relativePath}`;
          const contentType = getMimeType(relativePath);
          const content = fs.readFileSync(absPath);
          await Promise.all(adapters.map((a) => a.upload(storagePath, content, contentType)));
          uploaded++;
          opts.onFile?.();
        })
      )
    );

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed++;
        logger.warn(`  File failed: ${files[i]} — ${r.reason}`);
      }
    });

    return { uploaded, failed };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function bundleMode(opts: {
  git: ReturnType<typeof simpleGit>;
  repoUrl: string;
  tmpDir: string;
  owner: string;
  repo: string;
  adapters: StorageAdapter[];
  dryRun: boolean;
}): Promise<CloneResult> {
  const { git, repoUrl, tmpDir, owner, repo, adapters, dryRun } = opts;
  const mirrorDir = path.join(tmpDir, 'repo.git');
  const bundlePath = path.join(tmpDir, 'repo.bundle');

  logger.debug(`Mirror cloning ${owner}/${repo} for bundle`);
  await git.clone(repoUrl, mirrorDir, ['--mirror']);
  await simpleGit(mirrorDir).raw(['bundle', 'create', bundlePath, '--all']);

  if (dryRun) return { uploaded: 1, failed: 0 };

  const content = fs.readFileSync(bundlePath);
  const storagePath = `${owner}/${repo}/repo.bundle`;
  await Promise.all(adapters.map((a) => a.upload(storagePath, content, 'application/octet-stream')));
  logger.info(`  Bundle uploaded: ${storagePath} (${(content.length / 1024 / 1024).toFixed(1)} MB)`);

  return { uploaded: 1, failed: 0 };
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}
