import { simpleGit, SimpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { Repo } from '@/lib/github';
import type { StorageAdapter } from '@/lib/adapters/base';
import type { ExtractionRequest, ExtractionSummary } from '@/lib/extractor';

export async function processMirrorRepo(args: {
  repo: Repo;
  adapters: StorageAdapter[];
  req: ExtractionRequest;
  summary: ExtractionSummary;
  pat: string;
  onLog: (msg: string) => void;
}): Promise<void> {
  const { repo, adapters, req, summary, pat, onLog } = args;
  const label = `${repo.owner}/${repo.name}`;
  onLog(`[start] ${label} (mirror)`);

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'detiq-mirror-'));
  const repoDir = path.join(tmpDir, 'repo.git');
  const bundlePath = path.join(tmpDir, 'repository.bundle');
  const refsPath = path.join(tmpDir, 'refs.json');
  const manifestPath = path.join(tmpDir, 'manifest.json');

  try {
    const git: SimpleGit = simpleGit();
    
    try {
      // 1. git clone --mirror
      const authUrl = `https://oauth2:${pat}@github.com/${repo.owner}/${repo.name}.git`;
      onLog(`  Cloning ${label}...`);
      await git.clone(authUrl, repoDir, ['--mirror']);
      
      if (req.signal?.aborted) throw new Error('Run cancelled');

      const repoGit = simpleGit(repoDir);

      // 2. git bundle create
      onLog(`  Creating bundle for ${label}...`);
      await repoGit.raw(['bundle', 'create', bundlePath, '--all']);
      
      if (req.signal?.aborted) throw new Error('Run cancelled');

      // Get refs
      const rawRefs = await repoGit.raw(['show-ref']);
      const refs = rawRefs.trim().split('\n').filter(Boolean).map(line => {
        const [sha, ref] = line.split(' ');
        return { sha, ref };
      });
      await fs.promises.writeFile(refsPath, JSON.stringify(refs, null, 2));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(msg.replace(new RegExp(pat, 'g'), '***'));
    }

    // Get bundle size and checksum
    const bundleStat = await fs.promises.stat(bundlePath);
    if (req.maxFileSizeKb && bundleStat.size > req.maxFileSizeKb * 1024) {
      throw new Error(`Bundle size (${Math.round(bundleStat.size / 1024)}KB) exceeds max file size of ${req.maxFileSizeKb}KB`);
    }

    const bundleHash = crypto.createHash('sha256');
    const bundleStream = fs.createReadStream(bundlePath);
    for await (const chunk of bundleStream) {
      bundleHash.update(chunk);
    }
    const bundleSha256 = bundleHash.digest('hex');

    // Create manifest
    const manifest = {
      repository: `${repo.owner}/${repo.name}`,
      defaultBranch: repo.defaultBranch,
      captureMode: 'mirror',
      timestamp: new Date().toISOString(),
      artifacts: [
        { name: 'repository.bundle', size: bundleStat.size, sha256: bundleSha256 },
        { name: 'refs.json' }
      ]
    };
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    // Upload
    onLog(`  Uploading bundle and manifests for ${label}...`);
    for (const adapter of adapters) {
      const storageBase = `${repo.owner}/${repo.name}`;
      
      const bundleBuffer = await fs.promises.readFile(bundlePath);
      await adapter.upload(`${storageBase}/repository.bundle`, bundleBuffer, 'application/octet-stream');
      
      const refsBuffer = await fs.promises.readFile(refsPath);
      await adapter.upload(`${storageBase}/refs.json`, refsBuffer, 'application/json');
      
      const manifestBuffer = await fs.promises.readFile(manifestPath);
      await adapter.upload(`${storageBase}/manifest.json`, manifestBuffer, 'application/json');
    }

    summary.uploadedFiles += 3; // bundle, refs, manifest
    onLog(`[done] ${label} (mirror)`);

  } finally {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch (e) {
      onLog(`  [warn] Failed to clean up temp dir ${tmpDir}: ${e}`);
    }
  }
}
