import { emitRunEvent, getRunStore } from '@/lib/runs/store';
import { requestRunCancellation } from '@/lib/runs/worker';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const store = getRunStore();
  const stored = await store.getRun(runId);
  if (!stored) return Response.json({ error: 'Run not found' }, { status: 404 });

  if (['completed', 'partial', 'failed', 'cancelled', 'preflight_failed'].includes(stored.run.status)) {
    return Response.json({ run: stored.run });
  }

  const active = requestRunCancellation(runId);
  if (!active) {
    const run = await store.updateRun(runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      errorCode: 'RunCancelled',
      errorMessage: 'Run cancelled before worker start.',
    });
    await emitRunEvent(runId, 'run.cancelled', 'Run cancelled before worker start.');
    return Response.json({ run });
  }

  const run = await store.updateRun(runId, {
    status: 'cancelled',
    errorCode: 'RunCancellationRequested',
    errorMessage: 'Cancellation requested by operator.',
  });
  await emitRunEvent(runId, 'run.cancel_requested', 'Cancellation requested by operator.');
  return Response.json({ run });
}
