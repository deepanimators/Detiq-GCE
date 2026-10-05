#!/usr/bin/env node
import { Command } from 'commander';
import cron from 'node-cron';
import { config } from './config.js';
import { GitHubClient, type ListRepoOptions } from './github.js';
import { buildAdapters } from './adapters/index.js';
import { extractAll } from './extractor.js';
import { logger } from './logger.js';
import { StateManager } from './state.js';
import type { CloneMode } from './clone.js';
import { parseMetadataTypes, type MetadataOptions } from './metadata.js';

const DEFAULT_EXCLUDES = [
  'node_modules/', '.git/', 'dist/', 'build/', '.next/',
  '__pycache__/', '.DS_Store', '*.lock', '*.min.js', '*.min.css', '*.map',
];

const program = new Command();
program
  .name('github-extractor')
  .description('Extract GitHub repos → upload files to multiple storage targets in parallel')
  .version('1.0.0');

// ── Shared options added to both user + org commands ─────────────────────────
function addSharedOptions(cmd: Command): Command {
  return cmd
    // Filtering
    .option('--skip-forks', 'Skip forked repositories')
    .option('--skip-archived', 'Skip archived repositories')
    .option('--visibility <type>', 'all | public | private', 'all')
    .option('--match <regex>', 'Only repos whose name matches this regex')
    .option('--topics <tags>', 'Only repos with ALL these topics (comma-separated, AND match)')
    // Output
    .option('--dry-run', 'List files without uploading')
    .option('--exclude <patterns>', 'Extra exclude patterns (comma-separated)')
    .option('--no-default-excludes', 'Disable built-in excludes (node_modules, dist, *.lock…)')
    .option('--max-file-size <kb>', 'Skip files larger than N KB')
    .option('--log-file <path>', 'Write all output to a log file too')
    // Clone mode (Gap 1)
    .option('--clone-mode <mode>', 'Use git clone: shallow | full | bundle')
    // Metadata (Gap 2 + full comments/reviews)
    .option('--metadata', 'Backup metadata: issues+comments, PRs+reviews, releases+assets, wiki, labels, milestones')
    .option(
      '--metadata-types <types>',
      'Subset of metadata (comma-separated): issues, prs, releases, wiki, labels, milestones, issue-comments, pr-reviews, pr-comments, release-assets'
    )
    // Resume + Incremental (Gaps 3+4)
    .option('--state-db <path>', 'State file for resume + incremental (JSON)')
    .option('--incremental', 'Only extract files changed since last run (requires --state-db)')
    // Scheduling (Gap 3 ← new)
    .option('--schedule <cron>', 'Run on a cron schedule, e.g. "0 */6 * * *" (runs immediately then on schedule)')
    // Concurrency
    .option('--repo-concurrency <n>', 'Parallel repos')
    .option('--file-concurrency <n>', 'Parallel files per repo');
}

// ── Core run function (callable on schedule) ──────────────────────────────────
async function runOnce(
  target: { type: 'user'; name: string } | { type: 'org'; name: string },
  options: Record<string, any>
): Promise<void> {
  validateConfig(options);

  const client = new GitHubClient(config.github.pat);
  const adapters = buildAdapters();

  const listOpts: ListRepoOptions = {
    skipForks: options.skipForks ?? false,
    skipArchived: options.skipArchived ?? false,
    visibility: options.visibility ?? 'all',
    matchRegex: options.match,
    topics: options.topics?.split(',').map((t: string) => t.trim()),
  };

  logger.info(`[${new Date().toISOString()}] Listing repos for ${target.type}: ${target.name}`);
  const repos =
    target.type === 'user'
      ? await client.listUserRepos(target.name, listOpts)
      : await client.listOrgRepos(target.name, listOpts);

  logger.info(`Found ${repos.length} repos`);
  if (!repos.length) {
    logger.warn('No repos found — check PAT permissions, visibility filter, or regex');
    return;
  }

  // Exclude patterns
  let excludePatterns: string[] = [];
  if (options.defaultExcludes !== false) excludePatterns = [...DEFAULT_EXCLUDES];
  if (options.exclude) excludePatterns.push(...options.exclude.split(',').map((p: string) => p.trim()));

  // Clone mode
  const cloneMode = options.cloneMode as CloneMode | undefined;
  if (cloneMode && !['shallow', 'full', 'bundle'].includes(cloneMode)) {
    logger.error(`Invalid --clone-mode: ${cloneMode}. Use: shallow | full | bundle`);
    process.exit(1);
  }

  // Metadata
  let metadata: MetadataOptions | undefined;
  if (options.metadata) {
    metadata = parseMetadataTypes(options.metadataTypes);
    const enabled = Object.entries(metadata).filter(([, v]) => v).map(([k]) => k);
    logger.info(`Metadata: ${enabled.join(', ')}`);
    if (options.metadataTypes?.includes('issue-comments') || !options.metadataTypes) {
      logger.warn('Issue comments + PR reviews enabled — significantly increases API usage');
    }
  }

  // State DB
  let stateManager: StateManager | undefined;
  if (options.stateDb) {
    stateManager = new StateManager(options.stateDb);
    const stats = stateManager.stats();
    logger.info(`State DB: ${options.stateDb} (${stats.uploads} files, ${stats.repos} repos tracked)`);
  }

  if (options.incremental && !stateManager) {
    logger.error('--incremental requires --state-db');
    process.exit(1);
  }

  await extractAll({
    repos,
    client,
    adapters,
    pat: config.github.pat,
    repoConcurrency: options.repoConcurrency ? parseInt(options.repoConcurrency) : config.concurrency.repos,
    fileConcurrency: options.fileConcurrency ? parseInt(options.fileConcurrency) : config.concurrency.files,
    dryRun: options.dryRun ?? false,
    excludePatterns,
    maxFileSizeKb: options.maxFileSize ? parseInt(options.maxFileSize) : undefined,
    cloneMode,
    metadata,
    stateManager,
    incremental: options.incremental ?? false,
  });
}

// ── Gap 3 (scheduler): wraps runOnce with node-cron ──────────────────────────
async function run(
  target: { type: 'user'; name: string } | { type: 'org'; name: string },
  options: Record<string, any>
): Promise<void> {
  if (options.logFile) logger.init(options.logFile);

  if (!options.schedule) {
    await runOnce(target, options);
    logger.close();
    return;
  }

  // Validate cron expression
  if (!cron.validate(options.schedule)) {
    console.error(`Invalid cron expression: "${options.schedule}"`);
    console.error('Examples: "0 */6 * * *" (every 6h), "0 2 * * *" (daily 2am), "*/30 * * * *" (every 30min)');
    process.exit(1);
  }

  // Run immediately, then on schedule
  logger.info(`Scheduler started: ${options.schedule}`);
  logger.info('Running immediately...');
  await runOnce(target, options);

  const task = cron.schedule(options.schedule, async () => {
    logger.info(`[schedule] Triggered at ${new Date().toISOString()}`);
    try {
      await runOnce(target, options);
    } catch (e) {
      logger.error(`Scheduled run failed: ${e}`);
    }
  });

  logger.info(`Next run: ${options.schedule} (Ctrl+C to stop)`);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Scheduler stopped');
    task.stop();
    logger.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function validateConfig(options: Record<string, any>): void {
  if (!config.github.pat) {
    console.error('Error: GITHUB_PAT is required (.env, extractor.yaml, or EXTRACTOR_CONFIG env var)');
    process.exit(1);
  }
  const hasAdapter = config.r2 || config.s3 || config.gdrive || config.githubTarget || config.azure;
  if (!hasAdapter && !options.dryRun) {
    console.error('Error: No storage adapter configured. Set at least one in .env or extractor.yaml:');
    console.error('  R2:     R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
    console.error('  S3:     S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET');
    console.error('  Drive:  GDRIVE_CLIENT_EMAIL, GDRIVE_PRIVATE_KEY, GDRIVE_ROOT_FOLDER_ID');
    console.error('  GitHub: GITHUB_TARGET_OWNER, GITHUB_TARGET_REPO');
    console.error('  Azure:  AZURE_CONNECTION_STRING, AZURE_CONTAINER');
    process.exit(1);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
addSharedOptions(
  program
    .command('user <username>')
    .description('Extract all repos for a GitHub user')
    .action(async (username, options) => run({ type: 'user', name: username }, options))
);

addSharedOptions(
  program
    .command('org <orgname>')
    .description('Extract all repos for a GitHub organization')
    .action(async (orgname, options) => run({ type: 'org', name: orgname }, options))
);

program.parse();
