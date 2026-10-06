import { buildAdaptersFromConfig } from '@/lib/adapters';
import { runExtraction } from '@/lib/extractor';
import { redactSecrets } from '@/lib/adapters/base';
import type { Repo } from '@/lib/github';
import { emitRunEvent, getRunStore } from './store';
import type { RunCreatePayload } from './types';

type ActiveRun = {
  controller: AbortController;
  payload: RunCreatePayload;
  repositories: Repo[];
};

const activeRuns = new Map<string, ActiveRun>();

export function queueRun(runId: string, payload: RunCreatePayload, repositories: Repo[]): void {
  if (activeRuns.has(runId)) return;
  const controller = new AbortController();
  activeRuns.set(runId, { controller, payload, repositories });

  setTimeout(() => {
    void executeRun(runId, payload, repositories, controller).finally(() => {
      activeRuns.delete(runId);
    });
  }, 0);
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
