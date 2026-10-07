# Investigation-Derived Production Backlog

_Status: active · Updated 2026-10-07_

This backlog converts the 2026-10-07 investigation into implementation slices. It
does not replace the platform roadmap; it orders the next engineering work needed to
stop the observed failures.

## P0: Make the current platform truthful

### 1. Capture mode contract

Add a request/UI field that names the capture strategy.

```ts
type CaptureMode = 'mirror' | 'selective-api' | 'metadata-only';
```

Acceptance:

- UI defaults full code backup to `mirror`.
- Existing REST file copy is labeled `selective-api`.
- Metadata-only runs do not call tree/blob endpoints.
- Logs print the chosen mode at run start.

### 2. Mirror bundle vertical slice

Implement a bounded first version of Git-native capture:

1. Clone with `git clone --mirror`.
2. Create `repository.bundle`.
3. Upload bundle artifact.
4. Upload `refs.json`.
5. Upload `manifest.json`.
6. Verify checksum where the adapter supports verification.

Acceptance:

- A small private repository produces a bundle in R2.
- The bundle can be cloned or inspected after download.
- No PAT appears in process logs, app logs, or uploaded manifests.
- If the bundle exceeds the configured max size, the run fails with an actionable
  error instead of loading unbounded data into memory.

### 3. Metadata phase separation

Keep metadata optional and independently resumable.

Acceptance:

- Code capture can complete even when metadata is disabled.
- Deep metadata types can be disabled without editing code.
- Rate-limit pauses mention the metadata stage that caused them.

### 4. Worker visibility and admin boundary

Remove all normal-user workflows that require worker secrets.

Acceptance:

- Landing page never asks for `WORKER_SECRET`.
- `/api/worker` remains protected.
- Admin/operator docs explain how to trigger `/api/worker`.
- User-facing logs say "contact platform administrator" when worker dispatch fails.

## P1: Move from serverless slices to a production worker

### 5. Repository/stage job model

Queue smaller units than "entire run".

Suggested job types:

```text
discover.repositories
repository.mirror
repository.selective_files
repository.metadata
artifact.verify
run.finalize
```

Acceptance:

- One repository can fail without failing unrelated repositories.
- A retry only replays the failed repository/stage.
- Each job has a lease and idempotency key.

### 6. Durable database

Object storage is useful for manifests and queue bootstrap, but production job state
should move to a database with atomic claims.

Acceptance:

- Claiming a job is atomic.
- Requeued jobs keep `availableAt`.
- Run status is derived from repository/stage records.
- Dead-letter jobs are queryable from the admin surface.

### 7. External worker runtime

Deploy a worker outside the browser and outside short request lifetimes.

Acceptance:

- Worker can run Git commands with enough disk and wall time.
- Worker renews leases during long clone/bundle/upload stages.
- Worker writes structured progress events at least every 30 seconds.
- Worker can be horizontally scaled without duplicate artifact writes.

## P2: Make backups provable

### 8. Manifest-first artifacts

Every run and repository must write machine-readable manifests.

Acceptance:

- `run.json` lists repository outcomes.
- each repository has `manifest.json`;
- every artifact records kind, path, size, SHA-256, destination, and verification
  status;
- `latest.json` is only a pointer, never the only record.

### 9. Streaming adapter contract

Large mirror bundles should not be buffered entirely in memory.

Acceptance:

- adapters support stream upload;
- bundle upload reports bytes;
- checksum can be calculated while streaming;
- memory usage is bounded by chunk size, not repository size.

### 10. Restore and verification

Backup is incomplete until restore is proven.

Acceptance:

- mirror bundle restore dry-run exists;
- `git fsck` can be run on restored bundles;
- refs from restore match `refs.json`;
- metadata JSON/JSONL parses.

## P3: Auth hardening

### 11. GitHub App installation auth

Replace pasted PATs for organization-scale production usage.

Acceptance:

- organization owner can install the app;
- installation token is minted server-side;
- token is not stored in browser localStorage;
- repository permissions are least-privilege by capture mode;
- app handles SSO/installation permission errors clearly.

### 12. OAuth sign-in

Use OAuth for user identity and optional user-authorized source access.

Acceptance:

- OAuth client secret is server-only;
- callback validates state;
- tokens are encrypted server-side if persisted;
- org repo access errors distinguish missing user access from missing app install.

## Implementation order

1. Add capture mode contract and UI.
2. Add small-repo mirror bundle mode with size guard.
3. Keep selective API mode as current behavior.
4. Add metadata-only mode.
5. Add manifest writes for all modes.
6. Add stream upload interface.
7. Move workers to durable external runtime.
8. Add GitHub App auth.

## Non-negotiable guardrails

- Never log tokens or signed URLs.
- Never ask general users for platform worker secrets.
- Never mark a run `completed` when required artifacts are missing or unverified.
- Never silently treat GitHub tree truncation as success.
- Never use browser cache as the authoritative run state.
- Never retry permanent destination configuration failures as if they are transient.
