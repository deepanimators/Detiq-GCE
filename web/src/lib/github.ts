import { Octokit } from '@octokit/rest';
import { withRetry } from '@/lib/retry';

export type GitHubFile = { path: string; sha: string; size: number };

export type GitHubErrorDetails = {
  status?: number;
  message: string;
  documentationUrl?: string;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  retryAfter?: number;
  ssoRequired?: boolean;
};

export function getGitHubErrorDetails(error: unknown): GitHubErrorDetails {
  const value = error as {
    status?: number;
    message?: string;
    response?: {
      status?: number;
      data?: { message?: string; documentation_url?: string };
      headers?: Record<string, string | number | undefined>;
    };
  };
  const response = value.response;
  const status = value.status ?? response?.status;
  const headers = response?.headers ?? {};
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];
  const retryAfter = headers['retry-after'];
  const sso = headers['x-github-sso'];
  return {
    status,
    message: response?.data?.message ?? value.message ?? 'GitHub request failed.',
    documentationUrl: response?.data?.documentation_url,
    rateLimitRemaining: remaining === undefined ? undefined : Number(remaining),
    rateLimitReset: reset === undefined ? undefined : Number(reset),
    retryAfter: retryAfter === undefined ? undefined : Number(retryAfter),
    ssoRequired: typeof sso === 'string' && sso.length > 0,
  };
}

export function formatGitHubError(error: unknown): string {
  const details = getGitHubErrorDetails(error);
  if (details.status === 401) {
    return 'GitHub rejected the token (401). Check that the PAT is valid and has not expired.';
  }
  if (details.status === 403 && details.rateLimitRemaining === 0) {
    const reset = details.rateLimitReset
      ? ` Reset: ${new Date(details.rateLimitReset * 1000).toISOString()}.`
      : '';
    return `GitHub rate limit exhausted (403). Wait for the reset window and retry.${reset}`;
  }
  if (details.status === 403 && details.retryAfter) {
    return `GitHub secondary rate limit triggered (403). Retry after ${details.retryAfter}s and lower file concurrency.`;
  }
  if (details.status === 403 && details.ssoRequired) {
    return 'GitHub denied access (403). The PAT likely needs organization SSO authorization.';
  }
  if (details.status === 403) {
    return `GitHub denied access (403): ${details.message} Check repository access, organization SSO authorization, PAT permissions, and API concurrency.`;
  }
  if (details.status === 404) {
    return `GitHub resource was not found (404): ${details.message} Check the organization/user name and token visibility.`;
  }
  return details.status ? `GitHub request failed (${details.status}): ${details.message}` : details.message;
}

export type Repo = {
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  topics: string[];
  branches?: string[];
};

export type ListRepoOptions = {
  skipForks?: boolean;
  skipArchived?: boolean;
  visibility?: 'all' | 'public' | 'private';
  matchRegex?: string;
  topics?: string[];
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
            type: opts.visibility === 'public' ? 'public' : opts.visibility === 'private' ? 'private' : 'all',
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

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const branches: string[] = [];
    let page = 1;
    while (true) {
      const { data } = await withRetry(
        () => this.octokit.repos.listBranches({ owner, repo, per_page: 100, page }),
        { label: `listBranches ${owner}/${repo} p${page}` }
      );
      branches.push(...data.map((branch) => branch.name));
      if (data.length < 100) return branches;
      page++;
    }
  }

  async getChangedFiles(owner: string, repo: string, baseSha: string, headSha: string): Promise<string[]> {
    const { data } = await withRetry(
      () => this.octokit.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${baseSha}...${headSha}` }),
      { label: `compare ${owner}/${repo}` }
    );
    return (data.files ?? []).map((f) => f.filename);
  }

  async getFileTree(owner: string, repo: string, branch: string): Promise<GitHubFile[]> {
    const { data } = await withRetry(
      () => this.octokit.git.getTree({ owner, repo, tree_sha: branch, recursive: '1' }),
      { label: `getTree ${owner}/${repo}` }
    );

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

type GitHubRepoApiResponse = {
  owner?: { login?: string };
  name: string;
  default_branch?: string;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  topics?: string[];
};

function toRepo(r: GitHubRepoApiResponse, fallbackOwner: string): Repo {
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
