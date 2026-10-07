# Investigation: Browser State, Live Log, and UX

_Status: active · Updated 2026-10-07_

## Symptoms observed

The UI issues reported during testing were:

- Saved credentials were too broad; the user wanted save/clear controls per section.
- Refreshing the page appeared to clear knowledge of the current run.
- The live log became long and made users scroll too much.
- The UI needed a copy/download button for logs.
- The UI needed one line showing the actual error instead of requiring users to
  read all logs.
- When logs auto-scrolled, the left configuration panel moved down unexpectedly.
- General users saw worker-secret language that should belong only to platform
  administrators.

## Current implementation status

Relevant file:

- `web/src/app/page.tsx`

Implemented behavior:

1. **Per-section credential storage**
   - Source, R2, S3, Google Drive, GitHub target, and Azure each have independent
     save/clear behavior.
   - The UI restores only the sections the browser previously saved.

2. **Run cache**
   - Recent run display state is cached in `localStorage`.
   - Up to `MAX_CACHED_RUNS` are retained.
   - Up to `MAX_CACHED_LOG_LINES` are retained per cached run.
   - On refresh, the UI restores the active run and resumes SSE/polling if the run
     is not terminal.

3. **Live log actions**
   - Logs can be copied through the Clipboard API.
   - A fallback copy path uses a temporary `textarea` for older browsers.
   - Logs can be downloaded as a text file with run ID, status, and actual error.

4. **Actual error summary**
   - The log header area surfaces `currentRun.errorMessage` or a detected failure
     line so users do not need to inspect the full log.

5. **Routine log folding**
   - Repetitive worker/platform messages are hidden behind a details control.
   - The visible log keeps important start/done/warn/error messages in view.

6. **Contained log scrolling**
   - The log panel owns its scroll through `logScrollRef`.
   - Auto-scroll targets only the log container, not the whole document.
   - This avoids the left column jumping when new log lines arrive.

## Product boundary: browser cache is not durable backup state

Browser cache is useful for user convenience, but it has hard limits:

- users can clear it;
- private browsing may disable it;
- another browser/device will not see it;
- browser storage quotas vary;
- secrets in localStorage are readable by any JavaScript that runs in the same
  origin;
- it cannot be trusted as a legal/compliance audit record.

Therefore:

- localStorage may restore form fields and recent logs;
- server-side run state must remain the source of truth;
- artifact manifests in object storage must prove backup completeness;
- secrets should eventually move to a server-side secret store or GitHub App flow.

## Worker messaging UX

The UI should not expose `WORKER_SECRET` or `CRON_SECRET` to ordinary users.

Correct copy:

```text
Waiting for worker: the platform worker has not claimed this run yet. It should
start automatically; if it does not, contact the platform administrator.
```

Avoid:

```text
Call /api/worker with x-worker-secret.
Enter WORKER_SECRET or CRON_SECRET.
```

Those instructions belong in operator docs, not the landing page.

## Repository selection alignment

The repository selector should stay compact because a full list can become long.
Production behavior should be:

- collapsed by default until repositories are fetched;
- searchable by name/topic;
- displays selected count;
- allows select all / clear all;
- branch override is per repository;
- long lists are contained in their own scroll area;
- the live log remains sticky on desktop and independent from form scroll.

## Security notes

Local credential save is intentionally explicit because it trades convenience for
risk. The UI must continue to:

- never auto-save secrets;
- provide per-section clear buttons;
- warn that values are restored from this browser;
- avoid writing secrets to logs or run events;
- avoid storing platform worker secrets in the browser.

## Acceptance criteria

- A user can save R2 without saving the GitHub source token.
- A user can clear one section without clearing all others.
- Refreshing the page restores the last active run view and resumes polling.
- Copy/download logs include the actual error and run ID.
- Routine platform messages are folded without hiding real errors.
- New log lines do not scroll the left form column.
- No normal user-facing text asks for platform worker secrets.
