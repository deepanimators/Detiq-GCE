// Metadata backup: issues (+ comments), PRs (+ reviews + comments),
// releases (+ binary assets), labels, milestones, wiki (git clone)
import { Octokit } from '@octokit/rest';
import simpleGit from 'simple-git';
import pLimit from 'p-limit';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { StorageAdapter } from './adapters/index.js';
import { withRetry } from './retry.js';
import { getMimeType } from './mime.js';
import { logger } from './logger.js';

export type MetadataOptions = {
  issues?: boolean;           // top-level issues
  issueComments?: boolean;    // comments per issue (many API calls)
  pullRequests?: boolean;     // top-level PRs
  prReviews?: boolean;        // reviews per PR
  prComments?: boolean;       // inline review comments per PR
  releases?: boolean;         // release metadata
  releaseAssets?: boolean;    // download + upload binary release assets
  wiki?: boolean;             // clone wiki repo + upload .md files
  labels?: boolean;
  milestones?: boolean;
};

// Convenience: parse comma list → MetadataOptions
export function parseMetadataTypes(types: string | undefined): MetadataOptions {
  if (!types) {
    // All enabled when --metadata set without --metadata-types
    return {
      issues: true, issueComments: true,
      pullRequests: true, prReviews: true, prComments: true,
      releases: true, releaseAssets: true,
      wiki: true, labels: true, milestones: true,
    };
  }
  const set = new Set(types.split(',').map((t) => t.trim().toLowerCase()));
  const has = (k: string) => set.has(k);
  return {
    issues: has('issues'),
    issueComments: has('issues') || has('issue-comments'),
    pullRequests: has('prs'),
    prReviews: has('prs') || has('pr-reviews'),
    prComments: has('prs') || has('pr-comments'),
    releases: has('releases'),
    releaseAssets: has('releases') || has('release-assets'),
    wiki: has('wiki'),
    labels: has('labels'),
    milestones: has('milestones'),
  };
}

export class MetadataExtractor {
  private octokit: Octokit;
  private pat: string;

  constructor(pat: string) {
    this.pat = pat;
    this.octokit = new Octokit({ auth: pat });
  }

  async extract(
    owner: string,
    repo: string,
    adapters: StorageAdapter[],
    opts: MetadataOptions
  ): Promise<void> {
    const base = `${owner}/${repo}/_metadata`;
    const tasks: Promise<void>[] = [];

    if (opts.wiki)         tasks.push(this.uploadWiki(owner, repo, base, adapters));
    if (opts.issues)       tasks.push(this.uploadIssues(owner, repo, base, adapters, opts));
    if (opts.pullRequests) tasks.push(this.uploadPRs(owner, repo, base, adapters, opts));
    if (opts.releases)     tasks.push(this.uploadReleases(owner, repo, base, adapters, opts));
    if (opts.labels)       tasks.push(this.uploadLabels(owner, repo, base, adapters));
    if (opts.milestones)   tasks.push(this.uploadMilestones(owner, repo, base, adapters));

    const results = await Promise.allSettled(tasks);
    results.forEach((r) => {
      if (r.status === 'rejected') logger.warn(`  Metadata task failed: ${r.reason}`);
    });
  }

  // ── Gap 1 addition: Wiki ─────────────────────────────────────────────────
  private async uploadWiki(owner: string, repo: string, base: string, adapters: StorageAdapter[]): Promise<void> {
    const wikiUrl = `https://${this.pat}@github.com/${owner}/${repo}.wiki.git`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `github-extractor-wiki-`));

    try {
      await simpleGit().clone(wikiUrl, tmpDir, ['--depth', '1']);
    } catch {
      // Repo has no wiki — not an error
      logger.debug(`  Wiki: ${owner}/${repo} has no wiki`);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    try {
      const files = walkDirFiltered(tmpDir);
      logger.info(`  Wiki: ${files.length} pages in ${owner}/${repo}`);

      await Promise.all(
        files.map(async (absPath) => {
          const rel = path.relative(tmpDir, absPath).replace(/\\/g, '/');
          const storagePath = `${base}/wiki/${rel}`;
          const content = fs.readFileSync(absPath);
          await Promise.all(adapters.map((a) => a.upload(storagePath, content, getMimeType(rel))));
        })
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ── Gap 4: Issues with comments ──────────────────────────────────────────
  private async uploadIssues(
    owner: string, repo: string, base: string,
    adapters: StorageAdapter[], opts: MetadataOptions
  ): Promise<void> {
    const issues: unknown[] = [];
    let page = 1;

    while (true) {
      const { data } = await withRetry(
        () => this.octokit.issues.listForRepo({ owner, repo, state: 'all', per_page: 100, page }),
        { label: `issues ${owner}/${repo} p${page}` }
      );
      if (!data.length) break;
      issues.push(...data.filter((i) => !i.pull_request));
      if (data.length < 100) break;
      page++;
    }

    if (opts.issueComments && issues.length) {
      logger.info(`  Metadata: fetching comments for ${issues.length} issues`);
      const limit = pLimit(5);
      await Promise.all(
        (issues as any[]).map((issue) =>
          limit(async () => {
            issue._comments = await this.fetchIssueComments(owner, repo, issue.number);
          })
        )
      );
    }

    await this.upload(`${base}/issues.json`, issues, adapters);
    logger.info(`  Metadata: ${issues.length} issues`);
  }

  private async fetchIssueComments(owner: string, repo: string, issueNumber: number): Promise<unknown[]> {
    const comments: unknown[] = [];
    let page = 1;
    while (true) {
      const { data } = await withRetry(
        () => this.octokit.issues.listComments({ owner, repo, issue_number: issueNumber, per_page: 100, page }),
        { label: `issue-comments #${issueNumber} p${page}` }
      );
      if (!data.length) break;
      comments.push(...data);
      if (data.length < 100) break;
      page++;
    }
    return comments;
  }

  // ── Gap 4: PRs with reviews + inline comments ─────────────────────────────
  private async uploadPRs(
    owner: string, repo: string, base: string,
    adapters: StorageAdapter[], opts: MetadataOptions
  ): Promise<void> {
    const prs: unknown[] = [];
    let page = 1;

    while (true) {
      const { data } = await withRetry(
        () => this.octokit.pulls.list({ owner, repo, state: 'all', per_page: 100, page }),
        { label: `PRs ${owner}/${repo} p${page}` }
      );
      if (!data.length) break;
      prs.push(...data);
      if (data.length < 100) break;
      page++;
    }

    if ((opts.prReviews || opts.prComments) && prs.length) {
      logger.info(`  Metadata: fetching reviews/comments for ${prs.length} PRs`);
      const limit = pLimit(5);
      await Promise.all(
        (prs as any[]).map((pr) =>
          limit(async () => {
            if (opts.prReviews) {
              pr._reviews = await this.fetchPRReviews(owner, repo, pr.number);
            }
            if (opts.prComments) {
              pr._review_comments = await this.fetchPRComments(owner, repo, pr.number);
            }
          })
        )
      );
    }

    await this.upload(`${base}/pull_requests.json`, prs, adapters);
    logger.info(`  Metadata: ${prs.length} pull requests`);
  }

  private async fetchPRReviews(owner: string, repo: string, prNumber: number): Promise<unknown[]> {
    const { data } = await withRetry(
      () => this.octokit.pulls.listReviews({ owner, repo, pull_number: prNumber, per_page: 100 }),
      { label: `pr-reviews #${prNumber}` }
    );
    return data;
  }

  private async fetchPRComments(owner: string, repo: string, prNumber: number): Promise<unknown[]> {
    const comments: unknown[] = [];
    let page = 1;
    while (true) {
      const { data } = await withRetry(
        () => this.octokit.pulls.listReviewComments({ owner, repo, pull_number: prNumber, per_page: 100, page }),
        { label: `pr-comments #${prNumber} p${page}` }
      );
      if (!data.length) break;
      comments.push(...data);
      if (data.length < 100) break;
      page++;
    }
    return comments;
  }

  // ── Gap 2: Releases with binary asset download ────────────────────────────
  private async uploadReleases(
    owner: string, repo: string, base: string,
    adapters: StorageAdapter[], opts: MetadataOptions
  ): Promise<void> {
    const releases: unknown[] = [];
    let page = 1;

    while (true) {
      const { data } = await withRetry(
        () => this.octokit.repos.listReleases({ owner, repo, per_page: 100, page }),
        { label: `releases ${owner}/${repo} p${page}` }
      );
      if (!data.length) break;
      releases.push(...data);
      if (data.length < 100) break;
      page++;
    }

    await this.upload(`${base}/releases.json`, releases, adapters);
    logger.info(`  Metadata: ${releases.length} releases`);

    // Download binary assets
    if (opts.releaseAssets && releases.length) {
      const limit = pLimit(3);
      await Promise.all(
        (releases as any[]).flatMap((release) =>
          (release.assets ?? []).map((asset: any) =>
            limit(async () => {
              try {
                const content = await this.downloadAsset(asset.browser_download_url);
                const storagePath = `${base}/releases/assets/${release.tag_name}/${asset.name}`;
                await Promise.all(
                  adapters.map((a) =>
                    a.upload(storagePath, content, asset.content_type ?? 'application/octet-stream')
                  )
                );
                logger.debug(`  Asset uploaded: ${asset.name} (${(content.length / 1024).toFixed(0)} KB)`);
              } catch (e) {
                logger.warn(`  Asset download failed: ${asset.name} — ${e}`);
              }
            })
          )
        )
      );
    }
  }

  private async downloadAsset(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: { Authorization: `token ${this.pat}`, Accept: 'application/octet-stream' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const buf = await response.arrayBuffer();
    return Buffer.from(buf);
  }

  // ── Labels + Milestones ──────────────────────────────────────────────────
  private async uploadLabels(owner: string, repo: string, base: string, adapters: StorageAdapter[]): Promise<void> {
    const { data } = await withRetry(
      () => this.octokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 }),
      { label: `labels ${owner}/${repo}` }
    );
    await this.upload(`${base}/labels.json`, data, adapters);
    logger.info(`  Metadata: ${data.length} labels`);
  }

  private async uploadMilestones(owner: string, repo: string, base: string, adapters: StorageAdapter[]): Promise<void> {
    const { data } = await withRetry(
      () => this.octokit.issues.listMilestones({ owner, repo, state: 'all', per_page: 100 }),
      { label: `milestones ${owner}/${repo}` }
    );
    await this.upload(`${base}/milestones.json`, data, adapters);
    logger.info(`  Metadata: ${data.length} milestones`);
  }

  private async upload(storagePath: string, data: unknown, adapters: StorageAdapter[]): Promise<void> {
    const content = Buffer.from(JSON.stringify(data, null, 2));
    await Promise.all(adapters.map((a) => a.upload(storagePath, content, 'application/json')));
  }
}

function walkDirFiltered(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDirFiltered(full));
    else results.push(full);
  }
  return results;
}
