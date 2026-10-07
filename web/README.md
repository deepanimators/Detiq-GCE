# Detiq GCE Web Control Plane

Next.js control plane for creating, preflighting, and monitoring GitHub backup runs.

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Run Lifecycle

The UI creates asynchronous backup runs through `POST /api/runs` and then monitors
`GET /api/runs/{runId}/events`.

Current API surface:

- `POST /api/preflight` validates GitHub source access and destination writability.
- `POST /api/runs` creates a durable run record, executes preflight, and queues work.
- `GET /api/runs/{runId}` returns run state and event history.
- `GET /api/runs/{runId}/events` streams replayable SSE events from a cursor.
- `POST /api/runs/{runId}/cancel` requests cancellation for active runs.
- `POST /api/cron` requires `targetType` and `targetName` in the authenticated
  request body; the target is supplied by the caller rather than hardcoded in
  deployment environment variables.

By default, local run state is written to `.detiq-runs/`. Set `RUN_STATE_DIR` to move
it elsewhere. Vercel deployments use the configured S3-compatible destination
(Cloudflare R2 or Amazon S3) for run records and queued jobs, so no Redis service is
required. Configure the matching `R2_*` or `S3_*` variables and
`RUN_QUEUE_ENCRYPTION_KEY`. The worker endpoint still requires an external scheduler
or worker runtime to process queued objects.

Credentials are intentionally not persisted in run state. The in-process worker keeps
submitted credentials only in memory long enough to execute the run. Production should
use a managed secret store before enabling durable cross-process retries.

## Build

```bash
npm run build
```
