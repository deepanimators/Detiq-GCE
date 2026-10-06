// Metadata backup for web — same as CLI but no wiki (no git binary on Vercel)
import { Octokit } from '@octokit/rest';
import pLimit from 'p-limit';
import type { StorageAdapter } from '@/lib/adapters/base';
import { withRetry } from '@/lib/retry';

type IssueMetadata = Record<string, unknown> & {
  number: number;
  pull_request?: unknown;
  _comments?: unknown[];
};

type PullRequestMetadata = Record<string, unknown> & {
  number: number;
  _reviews?: unknown[];
  _review_comments?: unknown[];
};

type ReleaseAssetMetadata = {
  browser_download_url?: string;
  name?: string;
  content_type?: string;
};

type ReleaseMetadata = Record<string, unknown> & {
  tag_name?: string;
  assets?: ReleaseAssetMetadata[];
};

export type MetadataOptions = {
  issues?: boolean;
  issueComments?: boolean;
  pullRequests?: boolean;
  prReviews?: boolean;
  prComments?: boolean;
  releases?: boolean;
  releaseAssets?: boolean;
  labels?: boolean;
  milestones?: boolean;
  // wiki not supported in web (no git binary on Vercel)
};

export function parseMetadataTypes(types: string | undefined): MetadataOptions {
  if (!types) {
    return {
      issues: true, issueComments: true,
      pullRequests: true, prReviews: true, prComments: true,
      releases: true, releaseAssets: true,
      labels: true, milestones: true,
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
    opts: MetadataOptions,
    log: (msg: string) => void
  ): Promise<void> {
    const base = `${owner}/${repo}/_metadata`;
    const tasks: Promise<void>[] = [];

    if (opts.issues)       tasks.push(this.uploadIssues(owner, repo, base, adapters, opts, log));
    if (opts.pullRequests) tasks.push(this.uploadPRs(owner, repo, base, adapters, opts, log));
    if (opts.releases)     tasks.push(this.uploadReleases(owner, repo, base, adapters, opts, log));
    if (opts.labels)       tasks.push(this.uploadLabels(owner, repo, base, adapters, log));
    if (opts.milestones)   tasks.push(this.uploadMilestones(owner, repo, base, adapters, log));

    const results = await Promise.allSettled(tasks);
    results.forEach((r) => {
      if (r.status === 'rejected') log(`  [warn] Metadata task failed: ${r.reason}`);
    });
  }

  private async uploadIssues(
    owner: string, repo: string, base: string,
    adapters: StorageAdapter[], opts: MetadataOptions, log: (msg: string) => void
  ): Promise<void> {
    const issues: IssueMetadata[] = [];
    let page = 1;
    while (true) {
      const { data } = await withRetry(
        () => this.octokit.issues.listForRepo({ owner, repo, state: 'all', per_page: 100, page }),
        { label: `issues ${owner}/${repo} p${page}`, log }
      );
      if (!data.length) break;
      issues.push(...(data.filter((i) => !i.pull_request) as IssueMetadata[]));
      if (data.length < 100) break;
      page++;
    }

    if (opts.issueComments && issues.length) {
      log(`  Fetching comments for ${issues.length} issues`);
      const limit = pLimit(5);
      await Promise.all(
        issues.map((issue) =>
          limit(async () => {
            issue._comments = await this.fetchIssueComments(owner, repo, issue.number, log);
          })
        )
      );
    }

    await this.upload(`${base}/issues.json`, issues, adapters);
    log(`  Metadata: ${issues.length} issues`);
  }

  private async fetchIssueComments(owner: string, repo: string, issueNumber: number, log: (msg: string) => void): Promise<unknown[]> {
    const comments: unknown[] = [];
    let page = 1;
    while (true) {
      const { data } = await withRetry(
        () => this.octokit.issues.listComments({ owner, repo, issue_number: issueNumber, per_page: 100, page }),
        { label: `issue-comments #${issueNumber} p${page}`, log }
      );
      if (!data.length) break;
      comments.push(...data);
      if (data.length < 100) break;
      page++;
    }
    return comments;
  }

  private async uploadPRs(
    owner: string, repo: string, base: string,
    adapters: StorageAdapter[], opts: MetadataOptions, log: (msg: string) => void
  ): Promise<void> {
    const prs: PullRequestMetadata[] = [];
    let page = 1;
    while (true) {
      const { data } = await withRetry(
        () => this.octokit.pulls.list({ owner, repo, state: 'all', per_page: 100, page }),
        { label: `PRs ${owner}/${repo} p${page}`, log }
      );
      if (!data.length) break;
      prs.push(...(data as PullRequestMetadata[]));
      if (data.length < 100) break;
      page++;
    }

    if ((opts.prReviews || opts.prComments) && prs.length) {
      log(`  Fetching reviews/comments for ${prs.length} PRs`);
      const limit = pLimit(5);
      await Promise.all(
        prs.map((pr) =>
          limit(async () => {
            if (opts.prReviews) pr._reviews = await this.fetchPRReviews(owner, repo, pr.number, log);
            if (opts.prComments) pr._review_comments = await this.fetchPRComments(owner, repo, pr.number, log);
          })
        )
      );
    }

    await this.upload(`${base}/pull_requests.json`, prs, adapters);
    log(`  Metadata: ${prs.length} pull requests`);
  }

  private async fetchPRReviews(owner: string, repo: string, prNumber: number, log: (msg: string) => void): Promise<unknown[]> {
    const { data } = await withRetry(
      () => this.octokit.pulls.listReviews({ owner, repo, pull_number: prNumber, per_page: 100 }),
      { label: `pr-reviews #${prNumber}`, log }
    );
    return data;
  }

  private async fetchPRComments(owner: string, repo: string, prNumber: number, log: (msg: string) => void): Promise<unknown[]> {
    const comments: unknown[] = [];
    let page = 1;
    while (true) {
      const { data } = await withRetry(
        () => this.octokit.pulls.listReviewComments({ owner, repo, pull_number: prNumber, per_page: 100, page }),
        { label: `pr-comments #${prNumber} p${page}`, log }
      );
      if (!data.length) break;
      comments.push(...data);
      if (data.length < 100) break;
      page++;
    }
    return comments;
  }

  private async uploadReleases(
    owner: string, repo: string, base: string,
    adapters: StorageAdapter[], opts: MetadataOptions, log: (msg: string) => void
  ): Promise<void> {
    const releases: ReleaseMetadata[] = [];
    let page = 1;
    while (true) {
      const { data } = await withRetry(
        () => this.octokit.repos.listReleases({ owner, repo, per_page: 100, page }),
        { label: `releases ${owner}/${repo} p${page}`, log }
      );
      if (!data.length) break;
      releases.push(...(data as ReleaseMetadata[]));
      if (data.length < 100) break;
      page++;
    }

    await this.upload(`${base}/releases.json`, releases, adapters);
    log(`  Metadata: ${releases.length} releases`);

    if (opts.releaseAssets && releases.length) {
      const limit = pLimit(3);
      await Promise.all(
        releases.flatMap((release) =>
          (release.assets ?? []).map((asset) =>
            limit(async () => {
              try {
                if (!asset.browser_download_url || !asset.name) return;
                const content = await this.downloadAsset(asset.browser_download_url);
                const storagePath = `${base}/releases/assets/${release.tag_name ?? 'untagged'}/${asset.name}`;
                await Promise.all(adapters.map((a) =>
                  a.upload(storagePath, content, asset.content_type ?? 'application/octet-stream')
                ));
              } catch (e) {
                log(`  [warn] Asset download failed: ${asset.name} — ${e}`);
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async uploadLabels(owner: string, repo: string, base: string, adapters: StorageAdapter[], log: (msg: string) => void): Promise<void> {
    const { data } = await withRetry(
      () => this.octokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 }),
      { label: `labels ${owner}/${repo}`, log }
    );
    await this.upload(`${base}/labels.json`, data, adapters);
    log(`  Metadata: ${data.length} labels`);
  }

  private async uploadMilestones(owner: string, repo: string, base: string, adapters: StorageAdapter[], log: (msg: string) => void): Promise<void> {
    const { data } = await withRetry(
      () => this.octokit.issues.listMilestones({ owner, repo, state: 'all', per_page: 100 }),
      { label: `milestones ${owner}/${repo}`, log }
    );
    await this.upload(`${base}/milestones.json`, data, adapters);
    log(`  Metadata: ${data.length} milestones`);
  }

  private async upload(storagePath: string, data: unknown, adapters: StorageAdapter[]): Promise<void> {
    const content = Buffer.from(JSON.stringify(data, null, 2));
    await Promise.all(adapters.map((a) => a.upload(storagePath, content, 'application/json')));
  }
}
