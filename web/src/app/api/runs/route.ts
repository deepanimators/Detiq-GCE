import { runPreflight } from '@/lib/preflight';
import { adapterNamesFromConfig, parseRunCreatePayload } from '@/lib/runs/request';
import {
  createRunRecord,
  emitRunEvent,
  getRunStore,
  RunStoreConfigurationError,
} from '@/lib/runs/store';
import { RunObjectStoreConfigurationError } from '@/lib/runs/object-store';
import { queueRun } from '@/lib/runs/worker';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const payload = parseRunCreatePayload(await req.json());
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

    const stored = await store.getRun(run.id);
    return Response.json({ run: stored?.run ?? run, preflight: preflightResponse }, { status: 202 });
  } catch (error) {
    if (error instanceof RunStoreConfigurationError || error instanceof RunObjectStoreConfigurationError) {
      return Response.json(
        {
          error: {
            code: error instanceof RunObjectStoreConfigurationError
              ? 'RUN_STORAGE_BUCKET_NOT_FOUND'
              : 'RUN_STORE_NOT_CONFIGURED',
            message: error.message,
          },
        },
        { status: 503 }
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}
