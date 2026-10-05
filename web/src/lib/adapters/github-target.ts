import { Octokit } from '@octokit/rest';
import { withRetry } from '@/lib/retry';
import type { StorageAdapter } from './base';

export class GitHubTargetAdapter implements StorageAdapter {
  readonly name = 'github-target';
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private branch: string;

  constructor(cfg: { owner: string; repo: string; branch?: string; pat: string }) {
    this.octokit = new Octokit({ auth: cfg.pat });
    this.owner = cfg.owner;
    this.repo = cfg.repo;
    this.branch = cfg.branch ?? 'main';
  }

  async upload(storagePath: string, content: Buffer, _contentType: string): Promise<void> {
    const contentBase64 = content.toString('base64');
    let existingSha: string | undefined;

    try {
      const { data } = await withRetry(
        () => this.octokit.repos.getContent({ owner: this.owner, repo: this.repo, path: storagePath, ref: this.branch }),
        { label: `gh-target getContent ${storagePath}` }
      );
      if (!Array.isArray(data) && data.type === 'file') existingSha = data.sha;
    } catch {
      // file doesn't exist yet
    }

    await withRetry(
      () => this.octokit.repos.createOrUpdateFileContents({
        owner: this.owner, repo: this.repo, path: storagePath,
        message: `chore: extract ${storagePath}`,
        content: contentBase64, branch: this.branch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
      { label: `gh-target put ${storagePath}` }
    );
  }
}
