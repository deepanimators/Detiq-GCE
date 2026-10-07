import { after } from 'next/server';
import { redactSecrets } from '@/lib/adapters/base';
import { emitRunEvent, getRunStore } from '@/lib/runs/store';
import { processQueuedRuns } from '@/lib/runs/worker';
import type { RunEvent } from '@/lib/runs/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const WORKER_NUDGE_COOLDOWN_MS = 60_000;
const queuedWorkerNudges = new Map<string, number>();

export async function GET(
  _req: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const stored = await getRunStore().getRun(runId);
  if (!stored) return Response.json({ error: 'Run not found' }, { status: 404 });
  if (stored.run.status === 'queued' && shouldNudgeQueuedWorker(runId, stored.events)) {
    nudgeQueuedWorker(runId);
  }
  return Response.json(stored);
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
      const result = await processQueuedRuns({ maxJobs: 3, maxRuntimeMs: 240_000 });
      const stored = await getRunStore().getRun(runId);
      if (stored?.run.status === 'queued') {
        await emitRunEvent(
          runId,
          'run.log',
          result.exhausted
            ? '[worker] Poll nudge found no claimable queued job. A previous worker lease may still be active.'
            : `[worker] Poll nudge processed ${result.processed} queued job(s), but this run is still waiting.`
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
