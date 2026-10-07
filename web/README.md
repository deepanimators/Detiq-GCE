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
- `POST /api/github/repos` fetches filtered repository metadata for the source
  selector without creating a run.
- `POST /api/runs` creates a durable run record, executes preflight, queues work,
  and asks the platform worker to start after the response is sent.
- `GET /api/runs/{runId}` returns run state and event history.
- `GET /api/runs/{runId}/events` streams replayable SSE events from a cursor.
- `POST /api/runs/{runId}/cancel` requests cancellation for active runs.
- `GET` or `POST /api/worker` is an internal platform endpoint that claims and
  processes one queued run. It accepts `CRON_SECRET` or `WORKER_SECRET` as
  `x-cron-secret`, `x-worker-secret`, or Bearer auth.
- `POST /api/cron` requires `targetType` and `targetName` in the authenticated
  request body; the target is supplied by the caller rather than hardcoded in
  deployment environment variables.

By default, local run state is written to `.detiq-runs/`. Set `RUN_STATE_DIR` to move
it elsewhere. Vercel deployments use the configured S3-compatible destination
(Cloudflare R2 or Amazon S3) for run records and queued jobs, so no Redis service is
required. Configure the matching `R2_*` or `S3_*` variables,
`RUN_QUEUE_ENCRYPTION_KEY`, and `CRON_SECRET` in Vercel. The committed
`vercel.json` invokes `/api/worker` every minute; Vercel sends `CRON_SECRET` as a
Bearer token for those cron calls. `POST /api/runs` also schedules a best-effort
post-response worker dispatch, so users do not need to know or enter any platform
secret. `WORKER_SECRET` is optional for non-Vercel external worker runtimes.
Queue claims use a lease (`RUN_QUEUE_LEASE_SECONDS`, default 900) so abandoned
claims can be reclaimed by a later worker. `DIRECT_RUN_REPO_LIMIT` only applies to
non-Vercel local development.

Credentials are intentionally not persisted in run state. The in-process worker keeps
submitted credentials only in memory long enough to execute the run. Production should
use a managed secret store before enabling durable cross-process retries.

## Build

```bash
npm run build
```
