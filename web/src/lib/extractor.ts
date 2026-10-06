import pLimit from 'p-limit';
import { GitHubClient, type Repo, type ListRepoOptions } from '@/lib/github';
import type { StorageAdapter } from '@/lib/adapters/base';
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
};

export type ExtractionSummary = {
  totalRepos: number;
  successRepos: number;
  totalFiles: number;
  uploadedFiles: number;
  skippedFiles: number;
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

  const listOpts: ListRepoOptions = {
    skipForks: req.skipForks,
    skipArchived: req.skipArchived,
    visibility: req.visibility ?? 'all',
    matchRegex: req.matchRegex,
    topics: req.topics,
  };

  onLog(`Listing repos for ${targetType}: ${targetName}`);
  const repos = targetType === 'user'
    ? await client.listUserRepos(targetName, listOpts)
    : await client.listOrgRepos(targetName, listOpts);

  if (!repos.length) {
    onLog('No repos found — check PAT permissions and filters');
    return { totalRepos: 0, successRepos: 0, totalFiles: 0, uploadedFiles: 0, skippedFiles: 0, failedFiles: 0 };
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
    totalRepos: repos.length, successRepos: 0,
    totalFiles: 0, uploadedFiles: 0, skippedFiles: 0, failedFiles: 0,
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
    .forEach((f) => onLog(`[error] Repo failed: ${f.reason}`));

  onLog('');
  onLog('=== Summary ===');
  onLog(`Repos:  ${summary.successRepos}/${summary.totalRepos} succeeded`);
  onLog(`Files:  ${summary.uploadedFiles} uploaded, ${summary.skippedFiles} skipped, ${summary.failedFiles} failed`);
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

  onLog(`[start] ${label}`);

  let files = await client.getFileTree(repo.owner, repo.name, repo.defaultBranch);

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
  onLog(`  ${files.length} files in ${label}`);

  if (dryRun) {
    summary.uploadedFiles += files.length;
    onLog(`[done] ${label} (dry-run)`);
  } else {
    const fileLimit = pLimit(fileConcurrency);
    let uploaded = 0;
    let failed = 0;

    const fileResults = await Promise.allSettled(
      files.map((file) =>
        fileLimit(async () => {
          const storagePath = `${repo.owner}/${repo.name}/${file.path}`;
          const content = await client.getFileContent(repo.owner, repo.name, file.sha);
          await Promise.all(adapters.map((a) => a.upload(storagePath, content, getMimeType(file.path))));
          uploaded++;
          if (uploaded % 50 === 0) onLog(`  Progress: ${uploaded}/${files.length} in ${label}`);
        })
      )
    );

    fileResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed++;
        onLog(`  [warn] File failed: ${files[i]?.path}`);
      }
    });

    summary.uploadedFiles += uploaded;
    summary.failedFiles += failed;
    onLog(`[done] ${label} — ${uploaded} uploaded${failed ? `, ${failed} failed` : ''}`);
  }

  // Metadata after files
  if (metadataOpts) {
    onLog(`  Extracting metadata for ${label}`);
    const extractor = new MetadataExtractor(pat);
    await extractor.extract(repo.owner, repo.name, adapters, metadataOpts, onLog);
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
