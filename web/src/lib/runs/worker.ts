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
import type { QueuedRun, RunCreatePayload } from './types';

type ActiveRun = {
  controller: AbortController;
  payload: RunCreatePayload;
  repositories: Repo[];
};

const activeRuns = new Map<string, ActiveRun>();

export async function queueRun(runId: string, payload: RunCreatePayload, repositories: Repo[]): Promise<void> {
  if (!isDurableRunQueueConfigured()) {
    throw new RunQueueConfigurationError(
      'Durable run queue is not configured. Set R2/S3 storage and RUN_QUEUE_ENCRYPTION_KEY before creating a run.'
    );
  }

  await enqueueRun({ runId, payload, repositories, enqueuedAt: new Date().toISOString() });

  const directLimit = Number(process.env.DIRECT_RUN_REPO_LIMIT ?? 0);
  if (process.env.VERCEL !== '1' && directLimit > 0 && repositories.length <= directLimit) {
    await processNextQueuedRun();
  }
}

export async function processNextQueuedRun(): Promise<boolean> {
  const claimed = await claimRun();
  if (!claimed) return false;
  const { job, token } = claimed;

  const controller = new AbortController();
  try {
    await executeRun(job.runId, job.payload, job.repositories, controller);
    await acknowledgeRun(token);
  } catch (error) {
    await getRunStore().updateRun(job.runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      errorCode: 'WorkerFailed',
      errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
    await emitRunEvent(job.runId, 'run.failed', 'Durable worker failed before acknowledging the job.');
    throw error;
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

  await store.updateRun(runId, {
    status: 'running',
    startedAt: new Date(startedAt).toISOString(),
    discoveredRepos: repositories.length,
  });
  await emitRunEvent(runId, 'run.started', `Run ${runId} started with ${repositories.length} repositories.`);

  try {
    const adapters = buildAdaptersFromConfig(payload.adapters);
    const summary = await runExtraction({
      pat: payload.pat,
      targetType: payload.targetType,
      targetName: payload.targetName,
      adapters,
      repositories,
      ...payload.options,
      onLog: (message) => {
        void emitRunEvent(runId, 'run.log', redactSecrets(message));
      },
      signal: controller.signal,
    });

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

    await emitRunEvent(
      runId,
      status === 'cancelled' ? 'run.cancelled' : 'run.failed',
      status === 'cancelled' ? 'Run cancelled by operator.' : message,
      { durationMs: Date.now() - startedAt, errorCode: status === 'cancelled' ? 'RunCancelled' : 'RunFailed' }
    );
  }
}
