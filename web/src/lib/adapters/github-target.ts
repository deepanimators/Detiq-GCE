import { Octokit } from '@octokit/rest';
import { createHash } from 'crypto';
import { withRetry } from '@/lib/retry';
import {
  normalizeStorageError,
  preflightFailure,
  type DurableStorageAdapter,
  type StorageHeadResult,
  type StoragePreflightResult,
} from './base';

export class GitHubTargetAdapter implements DurableStorageAdapter {
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

  
  async uploadStream(storagePath: string, stream: NodeJS.ReadableStream | AsyncIterable<Buffer>, contentType: string): Promise<{ size: number, sha256: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      size += chunk.length;
      hash.update(chunk as Buffer);
    }
    const content = Buffer.concat(chunks);
    await this.upload(storagePath, content);
    return { size, sha256: hash.digest('hex') };
  }

  async upload(storagePath: string, content: Buffer): Promise<void> {
    try {
      const contentBase64 = content.toString('base64');
      let existingSha: string | undefined;

      try {
        const { data } = await withRetry(
          () => this.octokit.repos.getContent({ owner: this.owner, repo: this.repo, path: storagePath, ref: this.branch }),
          { label: `gh-target getContent ${storagePath}` }
        );
        if (!Array.isArray(data) && data.type === 'file') existingSha = data.sha;
      } catch {
        // File does not exist yet.
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
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'upload');
    }
  }

  async preflight(): Promise<StoragePreflightResult> {
    try {
      const { data } = await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
      await this.octokit.repos.getBranch({ owner: this.owner, repo: this.repo, branch: this.branch });
      if (data.permissions && data.permissions.push !== true && data.permissions.admin !== true) {
        return {
          adapter: this.name,
          writable: false,
          errorCode: 'MissingPushPermission',
          errorCategory: 'authorization',
          retryable: false,
          message: `Token can read ${this.owner}/${this.repo}, but does not appear to have push permission.`,
        };
      }

      return {
        adapter: this.name,
        writable: true,
        versioning: true,
        message: `Repository ${this.owner}/${this.repo}@${this.branch} is reachable and appears writable.`,
      };
    } catch (error) {
      return preflightFailure(this.name, error);
    }
  }

  async head(storagePath: string): Promise<StorageHeadResult> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: storagePath,
        ref: this.branch,
      });
      if (Array.isArray(data) || data.type !== 'file') return { exists: false };
      return {
        exists: true,
        size: data.size,
        etag: data.sha,
      };
    } catch (error) {
      const normalized = normalizeStorageError(error, this.name, 'head');
      if (normalized.httpStatus === 404) return { exists: false };
      throw normalized;
    }
  }

  async verify(storagePath: string, sha256: string): Promise<void> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: storagePath,
        ref: this.branch,
      });
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
        throw new Error(`File does not exist: ${storagePath}`);
      }
      const actual = createHash('sha256').update(Buffer.from(data.content, 'base64')).digest('hex');
      if (actual !== sha256) {
        throw new Error(`Checksum mismatch for ${storagePath}: expected ${sha256}, got ${actual}`);
      }
    } catch (error) {
      throw normalizeStorageError(error, this.name, 'verify');
    }
  }

  async delete(storagePath: string): Promise<void> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: storagePath,
        ref: this.branch,
      });
      if (Array.isArray(data) || data.type !== 'file') return;
      await this.octokit.repos.deleteFile({
        owner: this.owner,
        repo: this.repo,
        path: storagePath,
        sha: data.sha,
        branch: this.branch,
        message: `chore: remove ${storagePath}`,
      });
    } catch (error) {
      const normalized = normalizeStorageError(error, this.name, 'delete');
      if (normalized.httpStatus !== 404) throw normalized;
    }
  }
}
