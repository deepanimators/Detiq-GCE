import { buildAdaptersFromConfig } from '@/lib/adapters';
import { runExtraction } from '@/lib/extractor';
import { redactSecrets } from '@/lib/adapters/base';
import type { Repo } from '@/lib/github';
import { emitRunEvent, getRunStore } from './store';
import {
  acknowledgeRun,
  claimRun,
  enqueueRun,
  isDurableRunQueueConfigured,
  RunQueueConfigurationError,
  renewLease,
} from './queue';
import type { RunCreatePayload } from './types';
import { RepoJobQueue } from './job-queue';

type ActiveRun = {
  controller: AbortController;
  payload: RunCreatePayload;
  repositories: Repo[];
};

type WorkerExecutionResult = {
  completed: boolean;
  remainingRepositories: Repo[];
  availableAt?: string;
};

const TERMINAL_STATUSES = new Set(['preflight_failed', 'completed', 'partial', 'failed', 'cancelled']);
const activeRuns = new Map<string, ActiveRun>();

export type WorkerBatchResult = {
  processed: number;
  exhausted: boolean;
  preferredRunClaimed?: boolean;
};

export async function queueRun(runId: string, payload: RunCreatePayload, repositories: Repo[]): Promise<void> {
  if (!isDurableRunQueueConfigured()) {
    throw new RunQueueConfigurationError(
      'Durable run queue is not configured. Set R2/S3 storage and RUN_QUEUE_ENCRYPTION_KEY before creating a run.'
    );
  }

  await enqueueRun({
    runId,
    payload,
    repositories,
    totalRepositories: repositories.length,
    enqueuedAt: new Date().toISOString(),
  });

  const directLimit = Number(process.env.DIRECT_RUN_REPO_LIMIT ?? 0);
  if (!isVercelRuntime() && directLimit > 0 && repositories.length <= directLimit) {
    await processQueuedRuns({ maxJobs: 1 });
  }
}

export async function processQueuedRuns(options: {
  maxJobs?: number;
  maxRuntimeMs?: number;
  preferredRunId?: string;
} = {}): Promise<WorkerBatchResult> {
  const defaultMaxJobs = isVercelRuntime() ? 1 : 5;
  const maxJobs = positiveInteger(options.maxJobs ?? Number(process.env.WORKER_BATCH_SIZE ?? defaultMaxJobs), defaultMaxJobs);
  const maxRuntimeMs = positiveInteger(options.maxRuntimeMs ?? Number(process.env.WORKER_BATCH_RUNTIME_MS ?? 270_000), 270_000);
  const deadline = Date.now() + maxRuntimeMs;
  let processed = 0;
  let preferredRunClaimed = false;

  while (processed < maxJobs && Date.now() < deadline) {
    const preferredRunId = processed === 0 ? options.preferredRunId : undefined;
    const claimed = await processNextQueuedRun(preferredRunId);
    if (!claimed) return { processed, exhausted: true, preferredRunClaimed };
    if (preferredRunId && claimed.runId === preferredRunId) preferredRunClaimed = true;
    processed += 1;
  }

  return { processed, exhausted: false, preferredRunClaimed };
}

export async function processNextQueuedRun(
  preferredRunId?: string
): Promise<{ runId: string } | null> {
  const claimed = await claimRun(preferredRunId ? { preferredRunId, exact: true } : undefined);
  if (!claimed) return null;
  const { job, token } = claimed;

  const controller = new AbortController();
  const stored = await getRunStore().getRun(job.runId);
  if (!stored || TERMINAL_STATUSES.has(stored.run.status)) {
    await acknowledgeRun(token);
    return { runId: job.runId };
  }

  activeRuns.set(job.runId, { controller, payload: job.payload, repositories: job.repositories });
  try {
    const result = await executeRun(
      job.runId,
      token,
      job.payload,
      job.repositories,
      job.totalRepositories ?? job.repositories.length,
      controller
    );
    await acknowledgeRun(token);
    if (!result.completed) {
      await enqueueRun({
        runId: job.runId,
        payload: job.payload,
        repositories: result.remainingRepositories,
        totalRepositories: job.totalRepositories ?? job.repositories.length,
        enqueuedAt: new Date().toISOString(),
        availableAt: result.availableAt,
      });
    }
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    await getRunStore().updateRun(job.runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      errorCode: 'WorkerFailed',
      errorMessage: message,
    });
    await emitRunEvent(job.runId, 'run.failed', `Durable worker failed before acknowledging the job: ${message}`);
    await acknowledgeRun(token);
  } finally {
    activeRuns.delete(job.runId);
  }
  return { runId: job.runId };
}

export function requestRunCancellation(runId: string): boolean {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.controller.abort();
  return true;
}

async function executeRun(
  runId: string,
  token: string,
  payload: RunCreatePayload,
  repositories: Repo[],
  totalRepositories: number,
  controller: AbortController
): Promise<WorkerExecutionResult> {
  const store = getRunStore();
  const startedAt = Date.now();
  let logChain = Promise.resolve();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const repoChunkSize = Math.min(repositories.length, workerRepoChunkSize());
  const chunk = repositories.slice(0, repoChunkSize);
  const remainingRepositories = repositories.slice(repoChunkSize);
  const existing = await store.getRun(runId);
  const completedBefore = existing?.run.completedRepos ?? 0;
  const failedBefore = existing?.run.failedRepos ?? 0;

  await store.updateRun(runId, {
    status: 'running',
    startedAt: existing?.run.startedAt ?? new Date(startedAt).toISOString(),
    discoveredRepos: totalRepositories,
  });
  await emitRunEvent(
    runId,
    'run.started',
    remainingRepositories.length
      ? `Run ${runId} processing ${chunk.length}/${repositories.length} queued repositories.`
      : `Run ${runId} processing final ${chunk.length} queued repositories.`
  );

  const adapters = buildAdaptersFromConfig(payload.adapters);
  const emitLog = (message: string) => {
    const safeMessage = redactSecrets(message);
    logChain = logChain
      .catch(() => undefined)
      .then(() => emitRunEvent(runId, 'run.log', safeMessage))
      .then(() => undefined);
  };

  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  try {
    heartbeatInterval = setInterval(() => {
      renewLease(token).catch(e => {
        emitLog(`[warning] Failed to renew lease: ${e.message}`);
      });
      emitLog(`[heartbeat] Worker is still processing slice...`);
    }, 30000);

    const workerId = process.env.VERCEL_URL || `worker-${Math.random().toString(36).substring(7)}`;
    const jobQueue = new RepoJobQueue(runId);

    // Enqueue jobs so they exist in the queue before we start trying to claim them.
    for (const repo of chunk) {
      await jobQueue.enqueue(`${repo.owner}-${repo.name}`);
    }

    const extraction = runExtraction({
      pat: payload.pat,
      targetType: payload.targetType,
      targetName: payload.targetName,
      adapters,
      repositories: chunk,
      ...payload.options,
      jobQueue,
      workerId,
      onLog: emitLog,
      onRepoComplete: (summary) => {
        void store.updateRun(runId, {
          completedRepos: completedBefore + summary.successRepos,
        });
      },
      signal: controller.signal,
    });
    const summary = await withRunTimeout(extraction, controller, runTimeoutMs());

    await logChain;

    const retryAfterRateLimit = getRetryAfterRateLimit(summary.rateLimitResetAt);
    const retryRepositories = retryAfterRateLimit && summary.successRepos === 0
      ? [...chunk, ...remainingRepositories]
      : remainingRepositories;
    if (retryAfterRateLimit && retryRepositories.length > 0) {
      await store.updateRun(runId, {
        status: 'queued',
        completedRepos: completedBefore + summary.successRepos,
        errorCode: 'GitHubRateLimited',
        errorMessage: `GitHub API rate limit exhausted. Retrying after ${retryAfterRateLimit}.`,
      });
      await emitRunEvent(
        runId,
        'run.queued',
        `GitHub API rate limit exhausted. Worker paused this run until ${retryAfterRateLimit}.`,
        { errorCode: 'GitHubRateLimited' }
      );
      return { completed: false, remainingRepositories: retryRepositories, availableAt: retryAfterRateLimit };
    }

    const completedRepos = completedBefore + summary.successRepos;
    const failedRepos = failedBefore + Math.max(0, summary.totalRepos - summary.successRepos);
    if (remainingRepositories.length) {
      await store.updateRun(runId, {
        status: 'queued',
        completedRepos,
        failedRepos,
      });
      await emitRunEvent(
        runId,
        'run.queued',
        `Worker slice completed: ${completedRepos}/${totalRepositories} repositories done. ${remainingRepositories.length} repository job(s) requeued.`
      );
      return { completed: false, remainingRepositories };
    }

    const terminalStatus = summary.failedFiles > 0 || failedRepos > 0 ? 'partial' : 'completed';
    await store.updateRun(runId, {
      status: terminalStatus,
      completedAt: new Date().toISOString(),
      completedRepos,
      failedRepos,
      partialRepos: terminalStatus === 'partial' ? failedRepos : 0,
    });

    await emitRunEvent(
      runId,
      terminalStatus === 'completed' ? 'run.completed' : 'run.partial',
      `Run ${terminalStatus}: ${completedRepos}/${totalRepositories} repositories, ${summary.failedFiles} failed files in final slice.`,
      { durationMs: Date.now() - startedAt }
    );
    return { completed: true, remainingRepositories: [] };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    const status = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';

    await store.updateRun(runId, {
      status,
      completedAt: new Date().toISOString(),
      errorCode: timedOut ? 'WorkerTimeout' : status === 'cancelled' ? 'RunCancelled' : 'RunFailed',
      errorMessage: message,
    });

    await logChain;
    await emitRunEvent(
      runId,
      status === 'cancelled' ? 'run.cancelled' : 'run.failed',
      status === 'cancelled' ? 'Run cancelled by operator.' : message,
      { durationMs: Date.now() - startedAt, errorCode: timedOut ? 'WorkerTimeout' : status === 'cancelled' ? 'RunCancelled' : 'RunFailed' }
    );
    return { completed: true, remainingRepositories: [] };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  }

  async function withRunTimeout<T>(promise: Promise<T>, activeController: AbortController, timeoutMs: number): Promise<T> {
    if (!timeoutMs) return promise;
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          activeController.abort();
          reject(new Error(`Worker exceeded ${Math.round(timeoutMs / 1000)}s runtime budget before completing the run.`));
        }, timeoutMs);
      }),
    ]);
  }
}

function isVercelRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_URL);
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function runTimeoutMs(): number {
  const fallback = isVercelRuntime() ? 240_000 : 0;
  return positiveInteger(Number(process.env.WORKER_RUN_TIMEOUT_MS ?? fallback), fallback);
}

function workerRepoChunkSize(): number {
  const fallback = isVercelRuntime() ? 1 : Number.MAX_SAFE_INTEGER;
  return positiveInteger(Number(process.env.WORKER_REPO_CHUNK_SIZE ?? fallback), fallback);
}

function getRetryAfterRateLimit(resetAt?: string): string | null {
  if (!resetAt) return null;
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs) || resetMs <= Date.now()) return null;
  const bufferSeconds = positiveInteger(Number(process.env.GITHUB_RATE_LIMIT_RETRY_BUFFER_SECONDS ?? 30), 30);
  return new Date(resetMs + bufferSeconds * 1000).toISOString();
}
