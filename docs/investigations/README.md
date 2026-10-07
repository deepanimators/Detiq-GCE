# Detiq GCE Investigation Index

_Status: active investigation baseline · Updated 2026-10-07_

This folder records the production investigation behind the current Detiq GCE web
platform work. It exists so future implementation does not rely on chat history or
Vercel log fragments.

## Current conclusion

The repeated failures are not one bug. They are four related system boundaries:

1. **Capture strategy:** the current web extractor is still REST tree/blob based for
   code. That is useful for selective exports, but it burns GitHub API quota quickly.
2. **Worker runtime:** Vercel functions can start small slices, but they are not a
   multi-hour worker runtime for large backups.
3. **Queue ownership:** platform worker secrets belong to deployment configuration,
   not to general users in the browser.
4. **Browser state:** localStorage is a convenience for restoring form values and
   recent logs after refresh. It must not become the system of record for a backup.

## Investigation files

| File | Purpose |
|---|---|
| [2026-10-07-worker-queue-and-vercel-runtime.md](2026-10-07-worker-queue-and-vercel-runtime.md) | Explains queued/running/stale worker behavior, Vercel runtime limits, Hobby cron limits, and the production worker path. |
| [2026-10-07-github-api-rate-limit-and-capture-modes.md](2026-10-07-github-api-rate-limit-and-capture-modes.md) | Explains the 403 failures, REST API budget exhaustion, why mirror/bundle mode is required, and where OAuth/GitHub App auth fits. |
| [2026-10-07-browser-state-live-log-and-ux.md](2026-10-07-browser-state-live-log-and-ux.md) | Explains per-section credential saves, run restore cache, live log copy/download, actual error summary, and scroll behavior. |
| [2026-10-07-production-implementation-backlog.md](2026-10-07-production-implementation-backlog.md) | Converts the investigation into implementation slices and acceptance criteria. |

## How to read this with the existing docs

- [../TARGET_ARCHITECTURE.md](../TARGET_ARCHITECTURE.md) is the destination
  architecture.
- [../PLATFORM_MATURITY_ROADMAP.md](../PLATFORM_MATURITY_ROADMAP.md) is the
  phased product roadmap.
- [../OPERATIONS_RUNBOOK.md](../OPERATIONS_RUNBOOK.md) is the operator response
  guide.
- This folder is the evidence and reasoning that connects the live failures to
  the architecture and roadmap.

## Decision summary

- Full code backup should default to **Git mirror/bundle mode**.
- The REST tree/blob path should be renamed and treated as **selective API mode**.
- Metadata backup should be a separate, optional, throttled phase.
- The browser should never ask a normal user for `WORKER_SECRET` or `CRON_SECRET`.
- Worker dispatch should be platform-owned and eventually move to a durable worker
  runtime with repository/stage-level leases.
- Logs should emphasize actionable errors and fold routine platform chatter.
