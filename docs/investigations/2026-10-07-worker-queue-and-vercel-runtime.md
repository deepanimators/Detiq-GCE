# Investigation: Worker Queue and Vercel Runtime

_Status: active · Updated 2026-10-07_

## Symptoms observed

The UI and deployment logs showed these patterns:

- A run remained `queued` with `0/2` repositories complete.
- The UI printed `Waiting for worker` and repeated worker nudge messages.
- A run later became `running`, then no repository progress appeared for minutes.
- The run eventually failed with:

```text
Worker stopped reporting progress for 420s. The serverless worker likely exceeded
the platform runtime limit before finishing.
```

- Vercel logs showed long polling of `GET /api/runs/{runId}` and earlier
  `Vercel Runtime Timeout Error: Task timed out after 300 seconds`.
- A per-minute cron expression failed on Vercel Hobby because Hobby cron schedules
  can only run once per day.

## What the current code does

Relevant files:

- `web/src/app/api/runs/route.ts`
- `web/src/app/api/runs/[runId]/route.ts`
- `web/src/app/api/worker/route.ts`
- `web/src/lib/runs/queue.ts`
- `web/src/lib/runs/store.ts`
- `web/src/lib/runs/worker.ts`

Current behavior:

1. `POST /api/runs` validates the request, preflights storage, creates a durable
   run record, queues repository work, and uses `after()` to nudge the worker.
2. On Vercel, run records and queue objects are stored in R2/S3 through the run
   object store. Locally, state is stored in `.detiq-runs/`.
3. `/api/worker` is an internal endpoint protected by `WORKER_SECRET` or
   `CRON_SECRET`.
4. On Vercel, the worker defaults to one repository per invocation
   (`WORKER_REPO_CHUNK_SIZE=1`) and a runtime budget below the platform timeout
   (`WORKER_RUN_TIMEOUT_MS`, default 240 seconds).
5. If a run is `queued`, polling `GET /api/runs/{runId}` can nudge the worker at
   most once per minute.
6. If a `running` run stops emitting events for `RUN_STALE_SECONDS` (default 420
   seconds on Vercel), polling marks it failed with `WorkerStale`.

## Root cause

The web platform currently uses Vercel functions as both control plane and worker.
That is acceptable for small bounded slices, but not for multi-hour backup work.

The platform has two constraints:

- **Function duration:** Vercel functions have a maximum invocation duration. The
  current routes export `maxDuration = 300`, and Vercel still terminates work that
  exceeds the plan/runtime limit.
- **Cron frequency:** Hobby cron jobs cannot run more than once per day. That means
  cron cannot be relied on for minute-by-minute queue draining on Hobby.

The queue improvements make the system recover better, but they do not transform
Vercel into a long-running worker host.

## Why normal users must not see Worker Control

`WORKER_SECRET` and `CRON_SECRET` are platform credentials. They authorize internal
job execution and belong in deployment secrets, not in a user form.

Correct user-facing behavior:

- User clicks **Create Backup Run**.
- The platform creates and queues the run.
- The platform worker claims the run automatically.
- If no worker claims the run, the UI says to contact the platform administrator.

Incorrect user-facing behavior:

- Asking a normal user to paste `WORKER_SECRET`.
- Persisting worker secrets in localStorage.
- Treating a browser tab as the queue worker.

## Production target

The production worker model should be:

```text
Next.js control plane
  ├── creates run
  ├── validates source/destination
  ├── writes durable run and job records
  └── returns immediately

Durable queue/database
  ├── repository jobs
  ├── capture stage jobs
  ├── retry windows
  ├── leases
  └── dead-letter records

External worker runtime
  ├── claims jobs with leases
  ├── renews leases while active
  ├── writes progress events
  ├── uploads artifacts
  └── requeues retryable failures
```

Recommended worker runtime options:

| Runtime | Fit |
|---|---|
| Fly.io/Railway/Render worker | Good for persistent Node workers and Git processes. |
| ECS/Fargate/Cloud Run Jobs | Best for large production workloads and controlled CPU/disk. |
| GitHub Actions scheduled/dispatch worker | Useful bootstrap option, less ideal for private customer workloads. |
| Vercel Pro cron + functions | Better recovery sweep than Hobby, but still bounded by function duration. |
| Vercel Workflows | Possible future direction if the platform wants Vercel-native durable execution. |

## Required implementation changes

1. Add a server-side worker deployment path that does not require browser secrets.
2. Move from run-level queue objects to repository/stage-level queue items.
3. Persist repository stage state separately from display logs.
4. Add lease renewal while a repository is actively being mirrored or uploaded.
5. Add `paused_until` / `availableAt` semantics for rate limits and transient
   failures.
6. Add dead-letter status after repeated permanent failures.
7. Keep `/api/worker` as an admin/cron compatibility endpoint, not as the main
   production execution strategy.

## Operator checks

When a run is stuck:

1. Check the run status and last event time.
2. Check whether the queue object exists and whether a claim lease is active.
3. Check `/api/worker` authorization only as an administrator.
4. Check whether the run is paused by `availableAt` after a GitHub rate limit.
5. Check Vercel function logs for timeout, memory, or unhandled exception.
6. If using Hobby cron, remember the cron recovery sweep can only run once per day.

## Acceptance criteria

- A normal user never needs a worker secret.
- A queued run is claimed automatically by a platform-owned worker.
- A worker crash leaves the run retryable from the last durable checkpoint.
- A Vercel timeout cannot leave the UI saying `running` forever.
- Repository-level progress continues after refresh because it is stored server-side.

## Official references checked

- Vercel Cron Jobs usage and pricing:
  `https://vercel.com/docs/cron-jobs/usage-and-pricing`
- Vercel function maximum duration:
  `https://vercel.com/docs/functions/configuring-functions/duration`
- Vercel function limitations:
  `https://vercel.com/docs/functions/limitations`
