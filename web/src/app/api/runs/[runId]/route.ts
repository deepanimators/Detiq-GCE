import { after } from 'next/server';
import { redactSecrets } from '@/lib/adapters/base';
import { emitRunEvent, getRunStore } from '@/lib/runs/store';
import { processQueuedRuns } from '@/lib/runs/worker';
import type { RunEvent, StoredRun } from '@/lib/runs/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const WORKER_NUDGE_COOLDOWN_MS = 60_000;
const queuedWorkerNudges = new Map<string, number>();

export async function GET(
  _req: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  let stored = await getRunStore().getRun(runId);
  if (!stored) return Response.json({ error: 'Run not found' }, { status: 404 });
  stored = await failStaleRunningRun(stored);
  if (stored.run.status === 'queued' && shouldNudgeQueuedWorker(runId, stored.events)) {
    nudgeQueuedWorker(runId);
  }
  return Response.json(stored);
}

async function failStaleRunningRun(stored: StoredRun): Promise<StoredRun> {
  if (stored.run.status !== 'running') return stored;

  const lastEventAt = latestEventTime(stored.events) ?? Date.parse(stored.run.startedAt ?? stored.run.createdAt);
  if (Date.now() - lastEventAt < staleRunMs()) return stored;

  const store = getRunStore();
  const message = `Worker stopped reporting progress for ${Math.round(staleRunMs() / 1000)}s. The serverless worker likely exceeded the platform runtime limit before finishing.`;
  await store.updateRun(stored.run.id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    errorCode: 'WorkerStale',
    errorMessage: message,
  });
  await emitRunEvent(stored.run.id, 'run.failed', message, { errorCode: 'WorkerStale' });
  return await store.getRun(stored.run.id) ?? stored;
}

function latestEventTime(events: RunEvent[]): number | null {
  const latest = events.at(-1)?.createdAt;
  return latest ? Date.parse(latest) : null;
}

function staleRunMs(): number {
  const fallbackSeconds = process.env.VERCEL ? 420 : 3600;
  const configuredSeconds = Number(process.env.RUN_STALE_SECONDS ?? fallbackSeconds);
  const seconds = Number.isFinite(configuredSeconds) && configuredSeconds > 0
    ? configuredSeconds
    : fallbackSeconds;
  return seconds * 1000;
}

function shouldNudgeQueuedWorker(runId: string, events: RunEvent[]): boolean {
  const latestInProcessNudge = queuedWorkerNudges.get(runId);
  if (latestInProcessNudge && Date.now() - latestInProcessNudge < WORKER_NUDGE_COOLDOWN_MS) return false;

  const lastWorkerNudge = events.findLast((event) =>
    event.type === 'run.log' && event.message?.startsWith('[worker] Polling detected queued run')
  );
  if (!lastWorkerNudge) return true;
  return Date.now() - Date.parse(lastWorkerNudge.createdAt) > WORKER_NUDGE_COOLDOWN_MS;
}

function nudgeQueuedWorker(runId: string): void {
  queuedWorkerNudges.set(runId, Date.now());
  pruneQueuedWorkerNudges();
  after(async () => {
    try {
      await emitRunEvent(runId, 'run.log', '[worker] Polling detected queued run; dispatcher nudged.');
      const result = await processQueuedRuns({ maxJobs: 1, maxRuntimeMs: 240_000, preferredRunId: runId });
      const stored = await getRunStore().getRun(runId);
      if (stored?.run.status === 'queued') {
        await emitRunEvent(
          runId,
          'run.log',
          result.preferredRunClaimed
            ? `[worker] Poll nudge processed ${result.processed} queued job(s), but this run is still waiting.`
            : '[worker] Poll nudge could not claim this run yet. It may be waiting for a scheduled retry window or a previous worker lease.'
        );
      }
    } catch (error) {
      await emitRunEvent(
        runId,
        'run.log',
        `[worker] Poll nudge failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`
      );
    }
  });
}

function pruneQueuedWorkerNudges(): void {
  const oldestAllowed = Date.now() - WORKER_NUDGE_COOLDOWN_MS * 5;
  for (const [runId, nudgedAt] of queuedWorkerNudges) {
    if (nudgedAt < oldestAllowed) queuedWorkerNudges.delete(runId);
  }
}
