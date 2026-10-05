import pLimit from 'p-limit';
import { GitHubClient, type Repo } from './github.js';
import type { StorageAdapter } from './adapters/index.js';
import { getMimeType } from './mime.js';
import { logger } from './logger.js';
import { StateManager } from './state.js';
import { ProgressManager, shouldUseProgress } from './progress.js';
import { MetadataExtractor, type MetadataOptions } from './metadata.js';
import { cloneAndUpload, type CloneMode } from './clone.js';

export type ExtractOptions = {
  repos: Repo[];
  client: GitHubClient;
  adapters: StorageAdapter[];
  repoConcurrency: number;
  fileConcurrency: number;
  pat: string;
  // Filtering
  dryRun?: boolean;
  excludePatterns?: string[];
  maxFileSizeKb?: number;
  // Gap 1
  cloneMode?: CloneMode;       // 'shallow' | 'full' | 'bundle' | undefined = API mode
  // Gap 2
  metadata?: MetadataOptions;
  // Gap 3+4
  stateManager?: StateManager;
  incremental?: boolean;       // only extract changed files (requires stateManager)
};

export type ExtractSummary = {
  totalRepos: number;
  successRepos: number;
  totalFiles: number;
  uploadedFiles: number;
  skippedFiles: number;
  failedFiles: number;
};

export async function extractAll(opts: ExtractOptions): Promise<ExtractSummary> {
  const { repos, client, adapters, repoConcurrency, fileConcurrency, dryRun = false } = opts;
  const adapterNames = adapters.map((a) => a.name);
  const useProgress = shouldUseProgress() && !dryRun;

  const progress = useProgress ? new ProgressManager(repos.length) : null;

  const logFn = (msg: string) => {
    if (progress) progress.log(msg);
    else logger.info(msg);
  };

  logFn(`Extracting ${repos.length} repos → [${adapterNames.join(', ')}]${dryRun ? ' (DRY RUN)' : ''}${opts.cloneMode ? ` (${opts.cloneMode} clone)` : ''}`);

  if (opts.stateManager) {
    const stats = opts.stateManager.stats();
    logFn(`State DB: ${stats.uploads} files tracked, ${stats.repos} repos seen`);
  }

  const summary: ExtractSummary = {
    totalRepos: repos.length, successRepos: 0,
    totalFiles: 0, uploadedFiles: 0, skippedFiles: 0, failedFiles: 0,
  };

  const repoLimit = pLimit(repoConcurrency);

  const results = await Promise.allSettled(
    repos.map((repo) =>
      repoLimit(() => processRepo({ repo, opts, summary, adapterNames, fileConcurrency, logFn, progress }))
    )
  );

  summary.successRepos = results.filter((r) => r.status === 'fulfilled').length;
  results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .forEach((f) => logger.error(`Repo failed: ${f.reason}`));

  // Save state after all repos complete
  opts.stateManager?.save();

  progress?.stop();

  logFn('');
  logFn('=== Summary ===');
  logFn(`Repos:  ${summary.successRepos}/${summary.totalRepos} succeeded`);
  logFn(`Files:  ${summary.uploadedFiles} uploaded, ${summary.skippedFiles} skipped, ${summary.failedFiles} failed`);
  if (dryRun) logFn('(dry-run: no files were actually uploaded)');

  return summary;
}

async function processRepo(args: {
  repo: Repo;
  opts: ExtractOptions;
  summary: ExtractSummary;
  adapterNames: string[];
  fileConcurrency: number;
  logFn: (msg: string) => void;
  progress: ProgressManager | null;
}): Promise<void> {
  const { repo, opts, summary, adapterNames, fileConcurrency, logFn, progress } = args;
  const { client, adapters, dryRun = false, stateManager, incremental } = opts;
  const label = `${repo.owner}/${repo.name}`;

  const tags = [
    repo.isPrivate ? 'private' : 'public',
    repo.isFork ? 'fork' : null,
    repo.isArchived ? 'archived' : null,
    repo.topics.length ? `topics: ${repo.topics.join(',')}` : null,
  ].filter(Boolean).join(', ');

  logFn(`[start] ${label} (${tags})`);

  // --- Gap 1: Clone mode ---
  if (opts.cloneMode) {
    const result = await cloneAndUpload({
      owner: repo.owner,
      repo: repo.name,
      defaultBranch: repo.defaultBranch,
      pat: opts.pat,
      adapters,
      fileConcurrency,
      mode: opts.cloneMode,
      dryRun,
      onFile: () => progress?.tickFile(),
    });
    summary.uploadedFiles += result.uploaded;
    summary.failedFiles += result.failed;
    progress?.tickRepo();
    logFn(`[done] ${label} — ${result.uploaded} uploaded${result.failed ? `, ${result.failed} failed` : ''}`);

    // Metadata after clone
    if (opts.metadata) await runMetadata(repo, adapters, opts, logFn);
    stateManager?.save(); // checkpoint
    return;
  }

  // --- API mode ---
  let headSha: string | undefined;

  // Gap 4: Incremental — get current HEAD, compare to stored
  if (incremental && stateManager) {
    headSha = await client.getRepoHeadSha(repo.owner, repo.name, repo.defaultBranch);
    const lastSha = stateManager.getRepoHead(repo.owner, repo.name);

    if (lastSha && lastSha === headSha) {
      logFn(`[skip] ${label} — no changes since last run`);
      summary.skippedFiles++;
      progress?.tickRepo();
      return;
    }

    if (lastSha && headSha) {
      const changedPaths = await client.getChangedFiles(repo.owner, repo.name, lastSha, headSha);
      logFn(`  Incremental: ${changedPaths.length} files changed since ${lastSha.slice(0, 7)}`);
      await processFiles({
        repo, opts, summary, adapterNames, fileConcurrency, logFn, progress,
        filePathFilter: new Set(changedPaths),
      });
      stateManager.setRepoHead(repo.owner, repo.name, headSha);
      stateManager.save();
      if (opts.metadata) await runMetadata(repo, adapters, opts, logFn);
      progress?.tickRepo();
      return;
    }
  }

  // Full extraction
  await processFiles({ repo, opts, summary, adapterNames, fileConcurrency, logFn, progress });

  if (incremental && stateManager) {
    if (!headSha) headSha = await client.getRepoHeadSha(repo.owner, repo.name, repo.defaultBranch);
    stateManager.setRepoHead(repo.owner, repo.name, headSha);
    stateManager.save();
  }

  if (opts.metadata) await runMetadata(repo, adapters, opts, logFn);
  progress?.tickRepo();
}

async function processFiles(args: {
  repo: Repo;
  opts: ExtractOptions;
  summary: ExtractSummary;
  adapterNames: string[];
  fileConcurrency: number;
  logFn: (msg: string) => void;
  progress: ProgressManager | null;
  filePathFilter?: Set<string>;
}): Promise<void> {
  const { repo, opts, summary, adapterNames, fileConcurrency, logFn, progress, filePathFilter } = args;
  const { client, adapters, dryRun = false, stateManager } = opts;
  const label = `${repo.owner}/${repo.name}`;

  let files = await client.getFileTree(repo.owner, repo.name, repo.defaultBranch);

  // Apply path filter (incremental mode)
  if (filePathFilter) {
    files = files.filter((f) => filePathFilter.has(f.path));
  }

  // Apply exclude patterns
  if (opts.excludePatterns?.length) {
    const before = files.length;
    files = files.filter((f) => !matchesAny(f.path, opts.excludePatterns!));
    const n = before - files.length;
    if (n) logFn(`  Excluded ${n} files by pattern`);
  }

  // Apply max file size
  if (opts.maxFileSizeKb) {
    const before = files.length;
    const maxBytes = opts.maxFileSizeKb * 1024;
    files = files.filter((f) => f.size <= maxBytes);
    const n = before - files.length;
    if (n) logFn(`  Excluded ${n} files > ${opts.maxFileSizeKb}KB`);
  }

  summary.totalFiles += files.length;
  progress?.startRepo(label, files.length);
  logFn(`  ${files.length} files to process in ${label}`);

  if (dryRun) {
    summary.uploadedFiles += files.length;
    return;
  }

  const fileLimit = pLimit(fileConcurrency);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    files.map((file) =>
      fileLimit(async () => {
        // Gap 3: Resume — skip already-uploaded files
        if (stateManager?.isUploaded(repo.owner, repo.name, file.path, file.sha, adapterNames)) {
          skipped++;
          progress?.tickFile();
          return;
        }

        const storagePath = `${repo.owner}/${repo.name}/${file.path}`;
        const contentType = getMimeType(file.path);
        const content = await client.getFileContent(repo.owner, repo.name, file.sha);

        await Promise.all(adapters.map((a) => a.upload(storagePath, content, contentType)));

        stateManager?.markUploaded(repo.owner, repo.name, file.path, file.sha, adapterNames);
        uploaded++;
        progress?.tickFile();

        if (uploaded % 100 === 0) logFn(`  Progress: ${uploaded + skipped}/${files.length} in ${label}`);
      })
    )
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed++;
      logger.warn(`  File failed: ${files[i].path} — ${r.reason}`);
    }
  });

  summary.uploadedFiles += uploaded;
  summary.skippedFiles += skipped;
  summary.failedFiles += failed;
  logFn(`[done] ${label} — ${uploaded} uploaded, ${skipped} skipped${failed ? `, ${failed} failed` : ''}`);
}

async function runMetadata(
  repo: Repo,
  adapters: StorageAdapter[],
  opts: ExtractOptions,
  logFn: (msg: string) => void
): Promise<void> {
  if (!opts.metadata) return;
  logFn(`  Extracting metadata for ${repo.owner}/${repo.name}`);
  const extractor = new MetadataExtractor(opts.pat);
  await extractor.extract(repo.owner, repo.name, adapters, opts.metadata);
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  const lower = filePath.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('**/')) return lower.includes(p.slice(3));
    if (p.startsWith('*.')) return lower.endsWith(p.slice(1));
    if (p.endsWith('/**') || p.endsWith('/'))
      return lower.startsWith(p.replace(/\/?\*\*$/, '/').replace(/^\//, ''));
    if (p.includes('/')) return lower.startsWith(p.endsWith('/') ? p : p + '/') || lower === p;
    return lower.includes(p);
  });
}
