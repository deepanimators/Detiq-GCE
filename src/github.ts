import { Octokit } from '@octokit/rest';
import { withRetry } from './retry.js';

export type GitHubFile = { path: string; sha: string; size: number };

export type Repo = {
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  topics: string[];
};

export type ListRepoOptions = {
  skipForks?: boolean;
  skipArchived?: boolean;
  visibility?: 'all' | 'public' | 'private';
  matchRegex?: string;        // Gap 5: regex on repo name
  topics?: string[];          // Gap 5: topic filter (AND match)
};

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export class GitHubClient {
  private octokit: Octokit;

  constructor(pat: string) {
    this.octokit = new Octokit({ auth: pat });
  }

  async listUserRepos(username: string, opts: ListRepoOptions = {}): Promise<Repo[]> {
    const repos: Repo[] = [];
    const regex = opts.matchRegex ? new RegExp(opts.matchRegex, 'i') : null;
    let page = 1;

    while (true) {
      const { data } = await withRetry(
        () => this.octokit.repos.listForUser({ username, per_page: 100, page, type: 'all' }),
        { label: `listUserRepos p${page}` }
      );
      if (!data.length) break;
      for (const r of data) {
        if (typeof r === 'string') continue;
        if (opts.skipForks && r.fork) continue;
        if (opts.skipArchived && r.archived) continue;
        if (opts.visibility === 'public' && r.private) continue;
        if (opts.visibility === 'private' && !r.private) continue;
        if (regex && !regex.test(r.name)) continue;
        const repo = toRepo(r, username);
        if (opts.topics?.length && !opts.topics.every((t) => repo.topics.includes(t))) continue;
        repos.push(repo);
      }
      if (data.length < 100) break;
      page++;
    }
    return repos;
  }

  async listOrgRepos(org: string, opts: ListRepoOptions = {}): Promise<Repo[]> {
    const repos: Repo[] = [];
    const regex = opts.matchRegex ? new RegExp(opts.matchRegex, 'i') : null;
    let page = 1;

    while (true) {
      const { data } = await withRetry(
        () =>
          this.octokit.repos.listForOrg({
            org,
            per_page: 100,
            page,
            type:
              opts.visibility === 'public' ? 'public' : opts.visibility === 'private' ? 'private' : 'all',
          }),
        { label: `listOrgRepos p${page}` }
      );
      if (!data.length) break;
      for (const r of data) {
        if (opts.skipForks && r.fork) continue;
        if (opts.skipArchived && r.archived) continue;
        if (regex && !regex.test(r.name)) continue;
        const repo = toRepo(r, org);
        if (opts.topics?.length && !opts.topics.every((t) => repo.topics.includes(t))) continue;
        repos.push(repo);
      }
      if (data.length < 100) break;
      page++;
    }
    return repos;
  }

  async getRepoHeadSha(owner: string, repo: string, branch: string): Promise<string> {
    const { data } = await withRetry(
      () => this.octokit.repos.getBranch({ owner, repo, branch }),
      { label: `getBranch ${owner}/${repo}` }
    );
    return data.commit.sha;
  }

  // Gap 4: incremental — returns only file paths changed between two commits
  async getChangedFiles(owner: string, repo: string, baseSha: string, headSha: string): Promise<string[]> {
    const { data } = await withRetry(
      () =>
        this.octokit.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${baseSha}...${headSha}`,
        }),
      { label: `compare ${owner}/${repo}` }
    );
    return (data.files ?? []).map((f) => f.filename);
  }

  async getFileTree(owner: string, repo: string, branch: string): Promise<GitHubFile[]> {
    const { data } = await withRetry(
      () => this.octokit.git.getTree({ owner, repo, tree_sha: branch, recursive: '1' }),
      { label: `getTree ${owner}/${repo}` }
    );

    if (data.truncated) {
      console.warn(`  [warn] Tree truncated for ${owner}/${repo} — very large repo, some files skipped`);
    }

    return (data.tree ?? [])
      .filter((node): node is typeof node & { path: string; sha: string } =>
        node.type === 'blob' && !!node.path && !!node.sha
      )
      .filter((node) => (node.size ?? 0) < MAX_FILE_SIZE_BYTES)
      .map((node) => ({ path: node.path, sha: node.sha, size: node.size ?? 0 }));
  }

  async getFileContent(owner: string, repo: string, sha: string): Promise<Buffer> {
    const { data } = await withRetry(
      () => this.octokit.git.getBlob({ owner, repo, file_sha: sha }),
      { label: `getBlob ${sha.slice(0, 7)}` }
    );
    return Buffer.from(data.content, 'base64');
  }
}

function toRepo(r: Record<string, any>, fallbackOwner: string): Repo {
  return {
    owner: r.owner?.login ?? fallbackOwner,
    name: r.name,
    defaultBranch: r.default_branch ?? 'main',
    isPrivate: r.private ?? false,
    isFork: r.fork ?? false,
    isArchived: r.archived ?? false,
    topics: r.topics ?? [],
  };
}
