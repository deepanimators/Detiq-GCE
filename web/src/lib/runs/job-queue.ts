import { getRunObjectWithEtag, putRunObjectOptimistic } from './object-store';

export type RepoJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface RepoJob {
  runId: string;
  repoKey: string;
  status: RepoJobStatus;
  workerId?: string;
  leaseExpiresAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class RepoJobQueue {
  private runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  private getJobKey(repoKey: string): string {
    return `jobs/${this.runId}/${repoKey}.json`;
  }

  async enqueue(repoKey: string): Promise<void> {
    const job: RepoJob = {
      runId: this.runId,
      repoKey,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      // Create only (fail if exists)
      await putRunObjectOptimistic(this.getJobKey(repoKey), JSON.stringify(job), '');
    } catch (e: any) {
      if (!e.message?.includes('OptimisticLockingFailed') && !e.message?.includes('ConditionNotMet')) {
        throw e;
      }
      // If it exists, it's already queued, which is fine
    }
  }

  async claim(repoKey: string, workerId: string, leaseDurationMs: number = 300000): Promise<{ job: RepoJob, etag: string } | null> {
    const key = this.getJobKey(repoKey);
    const existing = await getRunObjectWithEtag(key);
    if (!existing) return null;

    const job = JSON.parse(existing.body) as RepoJob;
    const now = Date.now();

    if (job.status === 'completed' || job.status === 'failed') return null;
    if (job.status === 'running' && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > now) {
      return null; // Locked by another worker
    }

    job.status = 'running';
    job.workerId = workerId;
    job.leaseExpiresAt = new Date(now + leaseDurationMs).toISOString();
    job.updatedAt = new Date(now).toISOString();

    try {
      const { etag } = await putRunObjectOptimistic(key, JSON.stringify(job), existing.etag);
      return { job, etag };
    } catch (e: any) {
      if (e.message?.includes('OptimisticLockingFailed')) {
        return null; // Another worker claimed it
      }
      throw e;
    }
  }

  async complete(repoKey: string, etag: string): Promise<void> {
    const key = this.getJobKey(repoKey);
    const existing = await getRunObjectWithEtag(key);
    if (!existing) throw new Error(`Job not found: ${key}`);

    const job = JSON.parse(existing.body) as RepoJob;
    job.status = 'completed';
    job.updatedAt = new Date().toISOString();
    
    // We could use the passed etag for strict concurrency, or current etag for "force complete"
    // Since we know the worker finished it, we force complete using current etag.
    await putRunObjectOptimistic(key, JSON.stringify(job), existing.etag);
  }

  async fail(repoKey: string, error: string): Promise<void> {
    const key = this.getJobKey(repoKey);
    const existing = await getRunObjectWithEtag(key);
    if (!existing) throw new Error(`Job not found: ${key}`);

    const job = JSON.parse(existing.body) as RepoJob;
    job.status = 'failed';
    job.error = error;
    job.updatedAt = new Date().toISOString();

    await putRunObjectOptimistic(key, JSON.stringify(job), existing.etag);
  }
}
