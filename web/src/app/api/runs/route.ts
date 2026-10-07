import { after } from 'next/server';
import { runPreflight } from '@/lib/preflight';
import { adapterNamesFromConfig, parseRunCreatePayload } from '@/lib/runs/request';
import {
  createRunRecord,
  emitRunEvent,
  getRunStore,
  RunStoreConfigurationError,
} from '@/lib/runs/store';
import { RunObjectStoreConfigurationError } from '@/lib/runs/object-store';
import { RunQueueConfigurationError } from '@/lib/runs/queue';
import { processQueuedRuns, queueRun } from '@/lib/runs/worker';
import { formatGitHubError, getGitHubErrorDetails } from '@/lib/github';
import { redactSecrets } from '@/lib/adapters/base';

import { resolveGitHubToken } from '@/lib/auth/token';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const rawPayload = await req.json();
    
    // Resolve the token (PAT, GitHub App, or Session)
    const pat = await resolveGitHubToken(rawPayload.pat, rawPayload.targetName, rawPayload.targetType);
    if (pat) {
      rawPayload.pat = pat;
    }

    const payload = parseRunCreatePayload(rawPayload);
    const adapterNames = adapterNamesFromConfig(payload.adapters);
    const store = getRunStore();
    const run = await store.createRun(createRunRecord({
      sourceType: payload.targetType,
      sourceName: payload.targetName,
      adapterNames,
      options: payload.options,
    }));

    await emitRunEvent(run.id, 'run.created', `Run ${run.id} created.`);

    const preflight = await runPreflight(payload);
    const { repositories, ...preflightResponse } = preflight;

    await store.updateRun(run.id, {
      estimatedRepos: repositories.length,
      discoveredRepos: repositories.length,
    });

    if (!preflight.ok) {
      const firstFailure = preflight.adapters.find((result) => !result.writable);
      await store.updateRun(run.id, {
        status: 'preflight_failed',
        completedAt: new Date().toISOString(),
        errorCode: firstFailure?.errorCode ?? 'PreflightFailed',
        errorMessage: firstFailure?.message ?? preflight.warnings[0] ?? 'Preflight failed.',
      });
      await emitRunEvent(
        run.id,
        'run.preflight_failed',
        firstFailure?.message ?? 'Preflight failed before extraction.',
        { adapter: firstFailure?.adapter, errorCode: firstFailure?.errorCode }
      );

      const stored = await store.getRun(run.id);
      return Response.json(
        { run: stored?.run ?? run, preflight: preflightResponse },
        { status: 422 }
      );
    }

    await emitRunEvent(run.id, 'run.queued', `Run queued with ${repositories.length} repositories.`);
    await queueRun(run.id, payload, repositories);
    dispatchWorkerAfterResponse(run.id);

    const stored = await store.getRun(run.id);
    return Response.json({ run: stored?.run ?? run, preflight: preflightResponse }, { status: 202 });
  } catch (error) {
    if (
      error instanceof RunStoreConfigurationError ||
      error instanceof RunObjectStoreConfigurationError ||
      error instanceof RunQueueConfigurationError
    ) {
      return Response.json(
        {
          error: {
            code: error instanceof RunObjectStoreConfigurationError
              ? 'RUN_STORAGE_BUCKET_NOT_FOUND'
              : error instanceof RunQueueConfigurationError
                ? 'RUN_QUEUE_NOT_CONFIGURED'
                : 'RUN_STORE_NOT_CONFIGURED',
            message: error.message,
          },
        },
        { status: 503 }
      );
    }
    const details = getGitHubErrorDetails(error);
    if (details.status === 401 || details.status === 403) {
      return Response.json(
        { error: formatGitHubError(error), code: details.status === 401 ? 'GITHUB_UNAUTHORIZED' : 'GITHUB_FORBIDDEN' },
        { status: details.status }
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}

function dispatchWorkerAfterResponse(runId: string): void {
  after(async () => {
    try {
      await emitRunEvent(runId, 'run.log', '[worker] Dispatcher started.');
      const result = await processQueuedRuns({ preferredRunId: runId });
      const stored = await getRunStore().getRun(runId);
      if (stored?.run.status === 'queued') {
        await emitRunEvent(
          runId,
          'run.log',
          result.preferredRunClaimed
            ? `[worker] Dispatcher processed ${result.processed} queued job(s), but this run is still waiting. It will retry on the next platform trigger.`
            : '[worker] Dispatcher could not claim this run yet. It may be waiting for a scheduled retry window or a previous worker lease; it will retry automatically.'
        );
      }
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      try {
        await getRunStore().updateRun(runId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          errorCode: 'WorkerDispatchFailed',
          errorMessage: message,
        });
        await emitRunEvent(runId, 'run.failed', `Worker dispatch failed. Please contact platform administrator.`, {
          errorCode: 'WorkerDispatchFailed',
        });
      } catch (eventError) {
        console.error('Unable to persist worker dispatch failure', eventError);
      }
      console.error('Post-response worker dispatch failed', error);
    }
  });
}
