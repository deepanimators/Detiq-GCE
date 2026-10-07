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
} from './queue';
import type { RunCreatePayload } from './types';

type ActiveRun = {
  controller: AbortController;
  payload: RunCreatePayload;
  repositories: Repo[];
};

const TERMINAL_STATUSES = new Set(['preflight_failed', 'completed', 'partial', 'failed', 'cancelled']);
const activeRuns = new Map<string, ActiveRun>();

export type WorkerBatchResult = {
  processed: number;
  exhausted: boolean;
};

export async function queueRun(runId: string, payload: RunCreatePayload, repositories: Repo[]): Promise<void> {
  if (!isDurableRunQueueConfigured()) {
    throw new RunQueueConfigurationError(
      'Durable run queue is not configured. Set R2/S3 storage and RUN_QUEUE_ENCRYPTION_KEY before creating a run.'
    );
  }

  await enqueueRun({ runId, payload, repositories, enqueuedAt: new Date().toISOString() });

  const directLimit = Number(process.env.DIRECT_RUN_REPO_LIMIT ?? 0);
  if (!isVercelRuntime() && directLimit > 0 && repositories.length <= directLimit) {
    await processQueuedRuns({ maxJobs: 1 });
  }
}

export async function processQueuedRuns(options: {
  maxJobs?: number;
  maxRuntimeMs?: number;
} = {}): Promise<WorkerBatchResult> {
  const maxJobs = positiveInteger(options.maxJobs ?? Number(process.env.WORKER_BATCH_SIZE ?? 5), 5);
  const maxRuntimeMs = positiveInteger(options.maxRuntimeMs ?? Number(process.env.WORKER_BATCH_RUNTIME_MS ?? 270_000), 270_000);
  const deadline = Date.now() + maxRuntimeMs;
  let processed = 0;

  while (processed < maxJobs && Date.now() < deadline) {
    const claimed = await processNextQueuedRun();
    if (!claimed) return { processed, exhausted: true };
    processed += 1;
  }

  return { processed, exhausted: false };
}

export async function processNextQueuedRun(): Promise<boolean> {
  const claimed = await claimRun();
  if (!claimed) return false;
  const { job, token } = claimed;

  const controller = new AbortController();
  const stored = await getRunStore().getRun(job.runId);
  if (!stored || TERMINAL_STATUSES.has(stored.run.status)) {
    await acknowledgeRun(token);
    return true;
  }

  activeRuns.set(job.runId, { controller, payload: job.payload, repositories: job.repositories });
  try {
    await executeRun(job.runId, job.payload, job.repositories, controller);
    await acknowledgeRun(token);
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
  return true;
}

export function requestRunCancellation(runId: string): boolean {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.controller.abort();
  return true;
}

async function executeRun(
  runId: string,
  payload: RunCreatePayload,
  repositories: Repo[],
  controller: AbortController
): Promise<void> {
  const store = getRunStore();
  const startedAt = Date.now();
  let logChain = Promise.resolve();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  await store.updateRun(runId, {
    status: 'running',
    startedAt: new Date(startedAt).toISOString(),
    discoveredRepos: repositories.length,
  });
  await emitRunEvent(runId, 'run.started', `Run ${runId} started with ${repositories.length} repositories.`);

  try {
    const adapters = buildAdaptersFromConfig(payload.adapters);
    const emitLog = (message: string) => {
      const safeMessage = redactSecrets(message);
      logChain = logChain
        .catch(() => undefined)
        .then(() => emitRunEvent(runId, 'run.log', safeMessage))
        .then(() => undefined);
    };

    const extraction = runExtraction({
      pat: payload.pat,
      targetType: payload.targetType,
      targetName: payload.targetName,
      adapters,
      repositories,
      ...payload.options,
      onLog: emitLog,
      onRepoComplete: (summary) => {
        void store.updateRun(runId, {
          completedRepos: summary.successRepos,
        });
      },
      signal: controller.signal,
    });
    const summary = await withRunTimeout(extraction, controller, runTimeoutMs());

    await logChain;

    const terminalStatus = summary.failedFiles > 0 ? 'partial' : 'completed';
    await store.updateRun(runId, {
      status: terminalStatus,
      completedAt: new Date().toISOString(),
      completedRepos: summary.successRepos,
      failedRepos: Math.max(0, summary.totalRepos - summary.successRepos),
      partialRepos: summary.failedFiles > 0 ? summary.totalRepos : 0,
    });

    await emitRunEvent(
      runId,
      terminalStatus === 'completed' ? 'run.completed' : 'run.partial',
      `Run ${terminalStatus}: ${summary.successRepos}/${summary.totalRepos} repositories, ${summary.failedFiles} failed files.`,
      { durationMs: Date.now() - startedAt }
    );
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    const status = controller.signal.aborted ? 'cancelled' : 'failed';

    await store.updateRun(runId, {
      status,
      completedAt: new Date().toISOString(),
      errorCode: status === 'cancelled' ? 'RunCancelled' : 'RunFailed',
      errorMessage: message,
    });

    await logChain;
    await emitRunEvent(
      runId,
      status === 'cancelled' ? 'run.cancelled' : 'run.failed',
      status === 'cancelled' ? 'Run cancelled by operator.' : message,
      { durationMs: Date.now() - startedAt, errorCode: status === 'cancelled' ? 'RunCancelled' : 'RunFailed' }
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  async function withRunTimeout<T>(promise: Promise<T>, activeController: AbortController, timeoutMs: number): Promise<T> {
    if (!timeoutMs) return promise;
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
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
