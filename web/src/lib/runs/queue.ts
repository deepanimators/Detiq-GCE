import crypto from 'crypto';
import type { QueuedRun } from './types';
import {
  getRunObjectWithEtag,
  putRunObjectOptimistic,
} from './object-store';

type ClaimLease = {
  claimedAt: string;
  leaseExpiresAt: string;
};

type JobState = {
  job: QueuedRun;
  claim?: ClaimLease;
};

export class RunQueueConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunQueueConfigurationError';
  }
}

function encryptionKey(): Buffer {
  const secret = process.env.RUN_QUEUE_ENCRYPTION_KEY;
  if (!secret) {
    throw new RunQueueConfigurationError(
      'Durable run queue encryption is not configured. Set RUN_QUEUE_ENCRYPTION_KEY.'
    );
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(value: JobState): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function decrypt(value: string): JobState {
  const [ivValue, tagValue, ciphertextValue] = value.split('.');
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error('Invalid queued run payload.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivValue, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  ) as JobState;
}

export function isDurableRunQueueConfigured(): boolean {
  return Boolean(
    process.env.RUN_QUEUE_ENCRYPTION_KEY &&
      (process.env.R2_BUCKET || process.env.S3_BUCKET)
  );
}

const QUEUE_STATE_KEY = 'queue/state.json';

type QueueState = {
  jobs: Record<string, string>; // runId -> encrypted JobState
};

async function getQueueState(): Promise<{ state: QueueState; etag: string }> {
  const res = await getRunObjectWithEtag(QUEUE_STATE_KEY);
  if (!res) {
    return { state: { jobs: {} }, etag: '' }; // empty state
  }
  return { state: JSON.parse(res.body), etag: res.etag };
}

export async function enqueueRun(job: QueuedRun): Promise<void> {
  let retries = 5;
  while (retries > 0) {
    const { state, etag } = await getQueueState();
    state.jobs[job.runId] = encrypt({ job });
    try {
      await putRunObjectOptimistic(QUEUE_STATE_KEY, JSON.stringify(state), etag);
      return;
    } catch (error: any) {
      if (error.message?.includes('OptimisticLockingFailed')) {
        retries--;
        await new Promise(r => setTimeout(r, 100 * Math.random()));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Failed to enqueue job due to high contention.');
}

export async function claimRun(options: {
  preferredRunId?: string;
  exact?: boolean;
} = {}): Promise<{ job: QueuedRun; token: string } | null> {
  const now = Date.now();
  let retries = 5;

  while (retries > 0) {
    const { state, etag } = await getQueueState();
    let selectedRunId: string | null = null;
    let selectedState: JobState | null = null;

    if (options.preferredRunId && state.jobs[options.preferredRunId]) {
      const jobState = decrypt(state.jobs[options.preferredRunId]!);
      if (isClaimable(jobState, now)) {
        selectedRunId = options.preferredRunId;
        selectedState = jobState;
      }
    }

    if (!selectedRunId && !options.exact) {
      for (const [runId, encryptedData] of Object.entries(state.jobs)) {
        try {
          const jobState = decrypt(encryptedData);
          if (isClaimable(jobState, now)) {
            selectedRunId = runId;
            selectedState = jobState;
            break;
          }
        } catch {
          // ignore invalid items
        }
      }
    }

    if (!selectedRunId || !selectedState) return null;

    selectedState.claim = {
      claimedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + claimLeaseMs()).toISOString(),
    };

    state.jobs[selectedRunId] = encrypt(selectedState);

    try {
      await putRunObjectOptimistic(QUEUE_STATE_KEY, JSON.stringify(state), etag);
      return { job: selectedState.job, token: selectedRunId };
    } catch (error: any) {
      if (error.message?.includes('OptimisticLockingFailed')) {
        retries--;
        await new Promise(r => setTimeout(r, 100 * Math.random()));
        continue;
      }
      throw error;
    }
  }
  return null;
}

export async function acknowledgeRun(token: string): Promise<void> {
  const runId = token; // token is just runId in this model
  let retries = 5;
  while (retries > 0) {
    const { state, etag } = await getQueueState();
    if (!state.jobs[runId]) return; // already removed
    delete state.jobs[runId];

    try {
      await putRunObjectOptimistic(QUEUE_STATE_KEY, JSON.stringify(state), etag);
      return;
    } catch (error: any) {
      if (error.message?.includes('OptimisticLockingFailed')) {
        retries--;
        await new Promise(r => setTimeout(r, 100 * Math.random()));
        continue;
      }
      throw error;
    }
  }
}

function isClaimable(jobState: JobState, now: number): boolean {
  if (jobState.job.availableAt && Date.parse(jobState.job.availableAt) > now) {
    return false;
  }
  if (!jobState.claim) return true;
  if (Date.parse(jobState.claim.leaseExpiresAt) < now) return true; // lease expired
  return false;
}

function claimLeaseMs(): number {
  const configuredSeconds = Number(process.env.RUN_QUEUE_LEASE_SECONDS ?? 900);
  const seconds = Number.isFinite(configuredSeconds) && configuredSeconds > 0
    ? configuredSeconds
    : 900;
  return seconds * 1000;
}
