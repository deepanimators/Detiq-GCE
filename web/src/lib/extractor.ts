import pLimit from 'p-limit';
import { formatGitHubError, getGitHubErrorDetails, GitHubClient, type Repo, type ListRepoOptions } from '@/lib/github';
import { isDurableStorageAdapter, type StorageAdapter } from '@/lib/adapters/base';
import { getMimeType } from '@/lib/mime';
import { MetadataExtractor, parseMetadataTypes, type MetadataOptions } from '@/lib/metadata';

const DEFAULT_EXCLUDES = [
  'node_modules/', '.git/', 'dist/', 'build/', '.next/',
  '__pycache__/', '.DS_Store', '*.lock', '*.min.js', '*.min.css', '*.map',
];

export type ExtractionRequest = {
  pat: string;
  targetType: 'user' | 'org';
  targetName: string;
  adapters: StorageAdapter[];
  repositories?: Repo[];
  skipForks?: boolean;
  skipArchived?: boolean;
  visibility?: 'all' | 'public' | 'private';
  matchRegex?: string;
  topics?: string[];
  dryRun?: boolean;
  useDefaultExcludes?: boolean;
  extraExcludes?: string[];
  maxFileSizeKb?: number;
  repoConcurrency?: number;
  fileConcurrency?: number;
  metadata?: boolean;
  metadataTypes?: string;
  onLog: (msg: string) => void;
  onRepoComplete?: (summary: ExtractionSummary) => void;
  signal?: AbortSignal;
};

export type ExtractionSummary = {
  totalRepos: number;
  successRepos: number;
  totalFiles: number;
  uploadedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalFolders: number;
  uploadedFolders: number;
  skippedExistingFiles: number;
  skippedExistingFolders: number;
  rateLimitResetAt?: string;
};

type RepoProgress = {
  discoveredFiles: number;
  discoveredFolders: number;
  uploadedFiles: number;
  uploadedFolders: Set<string>;
  skippedExistingFiles: number;
  skippedExistingFolders: Set<string>;
  failedFiles: number;
};

export async function runExtraction(req: ExtractionRequest): Promise<ExtractionSummary> {
  const {
    pat, targetType, targetName, adapters,
    dryRun = false, onLog,
    repoConcurrency = parseInt(process.env.REPO_CONCURRENCY ?? '3'),
    fileConcurrency = parseInt(process.env.FILE_CONCURRENCY ?? '10'),
  } = req;

  const client = new GitHubClient(pat);
  throwIfAborted(req.signal);

  const listOpts: ListRepoOptions = {
    skipForks: req.skipForks,
    skipArchived: req.skipArchived,
    visibility: req.visibility ?? 'all',
    matchRegex: req.matchRegex,
    topics: req.topics,
  };

  onLog(req.repositories ? `Using preflight repository snapshot for ${targetType}: ${targetName}` : `Listing repos for ${targetType}: ${targetName}`);
  const repos = req.repositories ?? (
    targetType === 'user'
      ? await client.listUserRepos(targetName, listOpts)
      : await client.listOrgRepos(targetName, listOpts)
  );
  throwIfAborted(req.signal);

  if (!repos.length) {
    onLog('No repos found — check PAT permissions and filters');
    return createEmptySummary(0);
  }

  const adapterNames = adapters.map((a) => a.name).join(', ');
  onLog(`Found ${repos.length} repos → [${adapterNames}]${dryRun ? ' (DRY RUN)' : ''}`);

  const excludePatterns = [
    ...(req.useDefaultExcludes !== false ? DEFAULT_EXCLUDES : []),
    ...(req.extraExcludes ?? []),
  ];

  let metadataOpts: MetadataOptions | undefined;
  if (req.metadata) {
    metadataOpts = parseMetadataTypes(req.metadataTypes);
    const enabled = Object.entries(metadataOpts).filter(([, v]) => v).map(([k]) => k);
    onLog(`Metadata: ${enabled.join(', ')}`);
  }

  const summary: ExtractionSummary = {
    ...createEmptySummary(repos.length),
  };

  const repoLimit = pLimit(repoConcurrency);
  const results = await Promise.allSettled(
    repos.map((repo) =>
      repoLimit(() => processRepo({
        repo, client, adapters, excludePatterns, req, summary,
        fileConcurrency, metadataOpts, pat, onLog,
      }))
    )
  );

  summary.successRepos = results.filter((r) => r.status === 'fulfilled').length;
  results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .forEach((f) => {
      const resetAt = getRateLimitResetAt(f.reason);
      if (resetAt) summary.rateLimitResetAt = maxIsoTimestamp(summary.rateLimitResetAt, resetAt);
      onLog(`[error] Repo failed: ${formatGitHubError(f.reason)}`);
    });

  onLog('');
  onLog('=== Summary ===');
  onLog(`Repos:  ${summary.successRepos}/${summary.totalRepos} succeeded`);
  onLog(`Files:  ${summary.uploadedFiles} uploaded, ${summary.skippedFiles} skipped, ${summary.failedFiles} failed`);
  onLog(`Folders: ${summary.uploadedFolders}/${summary.totalFolders} with copied files${summary.skippedExistingFolders ? `, ${summary.skippedExistingFolders} already complete` : ''}`);
  if (summary.skippedExistingFiles) {
    onLog(`Resume: ${summary.skippedExistingFiles} existing file${summary.skippedExistingFiles === 1 ? '' : 's'} skipped from destination checkpoint.`);
  }
  if (dryRun) onLog('(dry-run: no files uploaded)');

  return summary;
}

async function processRepo(args: {
  repo: Repo;
  client: GitHubClient;
  adapters: StorageAdapter[];
  excludePatterns: string[];
  req: ExtractionRequest;
  summary: ExtractionSummary;
  fileConcurrency: number;
  metadataOpts: MetadataOptions | undefined;
  pat: string;
  onLog: (msg: string) => void;
}): Promise<void> {
  const { repo, client, adapters, excludePatterns, req, summary, fileConcurrency, metadataOpts, pat, onLog } = args;
  const label = `${repo.owner}/${repo.name}`;
  const { dryRun = false } = req;

  throwIfAborted(req.signal);
  onLog(`[start] ${label}`);
  const progress = createRepoProgress();

  let files = await client.getFileTree(repo.owner, repo.name, repo.defaultBranch);
  throwIfAborted(req.signal);

  if (excludePatterns.length) {
    const before = files.length;
    files = files.filter((f) => !matchesAny(f.path, excludePatterns));
    const n = before - files.length;
    if (n) onLog(`  Excluded ${n} files by pattern`);
  }

  if (req.maxFileSizeKb) {
    const maxBytes = req.maxFileSizeKb * 1024;
    const before = files.length;
    files = files.filter((f) => f.size <= maxBytes);
    const n = before - files.length;
    if (n) onLog(`  Excluded ${n} files > ${req.maxFileSizeKb}KB`);
  }

  summary.totalFiles += files.length;
  progress.discoveredFiles = files.length;
  progress.discoveredFolders = countFolders(files.map((file) => file.path));
  summary.totalFolders += progress.discoveredFolders;
  onLog(`  Plan: ${files.length} files across ${progress.discoveredFolders} folder${progress.discoveredFolders === 1 ? '' : 's'} in ${label}`);

  if (dryRun) {
    summary.uploadedFiles += files.length;
    summary.uploadedFolders += progress.discoveredFolders;
    progress.uploadedFiles += files.length;
    progress.uploadedFolders = new Set(files.map((file) => folderKey(file.path)));
    onLog(`[done] ${label} (dry-run)`);
  } else {
    const fileLimit = pLimit(fileConcurrency);
    let uploaded = 0;
    let fatalContentErrorMessage: string | null = null;
    let fatalContentError: unknown = null;

    const fileResults = await Promise.allSettled(
      files.map((file) =>
        fileLimit(async () => {
          if (fatalContentErrorMessage) throw new Error(fatalContentErrorMessage);
          throwIfAborted(req.signal);
          const storagePath = `${repo.owner}/${repo.name}/${file.path}`;
          let content: Buffer;
          const pendingAdapters = await adaptersMissingFile(adapters, storagePath, file.size);
          if (!pendingAdapters.length) {
            progress.skippedExistingFiles++;
            progress.skippedExistingFolders.add(folderKey(file.path));
            if (progress.skippedExistingFiles % 100 === 0) {
              onLog(`  Resume skip: ${progress.skippedExistingFiles}/${files.length} already copied in ${label}`);
            }
            return;
          }
          try {
            content = await client.getFileContent(repo.owner, repo.name, file.sha);
          } catch (error) {
            const message = formatGitHubError(error);
            if (getRateLimitResetAt(error)) {
              fatalContentError = error;
              fatalContentErrorMessage = `${message} Stopping ${label} until the GitHub rate-limit window resets.`;
              throw error;
            }
            if (message.includes('(403)')) {
              fatalContentErrorMessage = `${message} Stopping ${label} to avoid repeating the same GitHub failure for every file.`;
              throw new Error(fatalContentErrorMessage);
            }
            throw error;
          }
          throwIfAborted(req.signal);
          await Promise.all(pendingAdapters.map(async (a) => {
            try {
              await a.upload(storagePath, content, getMimeType(file.path));
            } catch (error) {
              throw new Error(`${a.name}: ${formatError(error)}`);
            }
          }));
          uploaded++;
          progress.uploadedFiles++;
          progress.uploadedFolders.add(folderKey(file.path));
          if (uploaded % 50 === 0) onLog(`  Progress: ${uploaded}/${files.length} in ${label}`);
        })
      )
    );

    fileResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        progress.failedFiles++;
        onLog(`  [warn] File failed: ${files[i]?.path} — ${formatError(r.reason)}`);
      }
    });

    if (fatalContentErrorMessage) {
      onLog(`  [error] ${fatalContentErrorMessage}`);
      applyRepoProgressToSummary(summary, progress);
      logRepoProgress(label, progress, onLog, '[progress]');
      if (fatalContentError) throw fatalContentError;
      throw new Error(fatalContentErrorMessage);
    }

    applyRepoProgressToSummary(summary, progress);
    logRepoProgress(label, progress, onLog, '[done]');
  }

  function formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) return String(error.message);
    return String(error);
  }

  // Metadata after files
  if (metadataOpts) {
    throwIfAborted(req.signal);
    onLog(`  Extracting metadata for ${label}`);
    const extractor = new MetadataExtractor(pat);
    await extractor.extract(repo.owner, repo.name, adapters, metadataOpts, onLog);
  }

  summary.successRepos += 1;
  req.onRepoComplete?.({ ...summary });
}

async function adaptersMissingFile(
  adapters: StorageAdapter[],
  storagePath: string,
  expectedSize: number
): Promise<StorageAdapter[]> {
  const checks = await Promise.all(adapters.map(async (adapter) => {
    if (!isDurableStorageAdapter(adapter)) return { adapter, exists: false };
    const head = await adapter.head(storagePath);
    return { adapter, exists: head.exists && (head.size === undefined || head.size === expectedSize) };
  }));

  return checks.filter((check) => !check.exists).map((check) => check.adapter);
}

function createEmptySummary(totalRepos: number): ExtractionSummary {
  return {
    totalRepos,
    successRepos: 0,
    totalFiles: 0,
    uploadedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    totalFolders: 0,
    uploadedFolders: 0,
    skippedExistingFiles: 0,
    skippedExistingFolders: 0,
  };
}

function createRepoProgress(): RepoProgress {
  return {
    discoveredFiles: 0,
    discoveredFolders: 0,
    uploadedFiles: 0,
    uploadedFolders: new Set<string>(),
    skippedExistingFiles: 0,
    skippedExistingFolders: new Set<string>(),
    failedFiles: 0,
  };
}

function logRepoProgress(
  label: string,
  progress: RepoProgress,
  onLog: (msg: string) => void,
  prefix: '[done]' | '[progress]'
): void {
  onLog(
    `${prefix} ${label} — ${progress.uploadedFiles} copied across ${progress.uploadedFolders.size} folder${progress.uploadedFolders.size === 1 ? '' : 's'}, ` +
    `${progress.skippedExistingFiles} already copied across ${progress.skippedExistingFolders.size} folder${progress.skippedExistingFolders.size === 1 ? '' : 's'}, ` +
    `${progress.failedFiles} failed of ${progress.discoveredFiles} planned files`
  );
}

function applyRepoProgressToSummary(summary: ExtractionSummary, progress: RepoProgress): void {
  summary.uploadedFiles += progress.uploadedFiles;
  summary.uploadedFolders += progress.uploadedFolders.size;
  summary.skippedExistingFiles += progress.skippedExistingFiles;
  summary.skippedExistingFolders += progress.skippedExistingFolders.size;
  summary.skippedFiles += progress.skippedExistingFiles;
  summary.failedFiles += progress.failedFiles;
}

function countFolders(filePaths: string[]): number {
  return new Set(filePaths.map(folderKey)).size;
}

function folderKey(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '(root)' : filePath.slice(0, index);
}

function getRateLimitResetAt(error: unknown): string | undefined {
  const details = getGitHubErrorDetails(error);
  if (details.status === 403 && details.rateLimitRemaining === 0 && details.rateLimitReset) {
    return new Date(details.rateLimitReset * 1000).toISOString();
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Reset:\s*([0-9TZ:.-]+)\.?/i);
  return match?.[1];
}

function maxIsoTimestamp(current: string | undefined, next: string): string {
  if (!current) return next;
  return Date.parse(next) > Date.parse(current) ? next : current;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Run cancelled');
  }
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
