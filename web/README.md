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

By default, local run state is written to `.detiq-runs/`. Set `RUN_STATE_DIR` to move
it elsewhere. Vercel deployments must configure `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`; the application refuses to use the read-only deployment
filesystem and returns `RUN_STORE_NOT_CONFIGURED` when those variables are missing.
The Redis REST store is the production implementation of the durable run-state
boundary. The in-process worker still requires a durable queue/worker runtime for
multi-instance execution; until that is deployed, use it only for small runs.

Credentials are intentionally not persisted in run state. The in-process worker keeps
submitted credentials only in memory long enough to execute the run. Production should
use a managed secret store before enabling durable cross-process retries.

## Build

```bash
npm run build
```
