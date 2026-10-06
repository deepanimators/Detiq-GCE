# Detiq GCE Target Architecture

## 1. Architectural principle

Separate **control plane**, **durable job state**, **capture workers**, **artifact
storage**, and **verification/restore**. The current Next.js route is a useful
control-plane prototype, but it should not own a multi-hour backup execution.

```text
Browser
  │ create / monitor / retry
  ▼
Next.js control plane
  ├── preflight API
  ├── job API
  └── manifest/query API
        │
        ▼
Durable database + queue
  ├── backup run
  ├── repository jobs
  ├── artifact attempts
  └── notification events
        │
        ▼
Workers
  ├── discover repositories
  ├── mirror/bundle Git refs
  ├── capture metadata
  ├── upload artifacts
  └── verify destinations
        │
        ▼
Object storage (system of record)
  ├── immutable run artifacts
  ├── manifests/checksums
  └── retention/versioning/object lock
```

## 2. Capture modes

### Mirror mode (default for full backups)

1. Resolve repository and default branch.
2. `git clone --mirror` or fetch/prune an existing bare repository.
3. Fetch Git LFS objects when enabled.
4. Produce a compressed bundle or bare repository artifact.
5. Record refs, head SHAs, LFS status, size, and checksum.

### Selective API mode

Use the GitHub tree/blob API only when the operator needs:

- repository/file filters that cannot be represented by Git;
- previews or small exports;
- a destination that cannot accept a repository artifact;
- a metadata-only or partial capture.

If `tree.truncated` is true, the repository must become `partial` or fall back to
mirror mode.

### Metadata mode

Each metadata type is independently paginated and checkpointed:

```text
metadata/
  repository.json
  issues.jsonl
  issue-comments.jsonl
  pull-requests.jsonl
  pull-request-reviews.jsonl
  pull-request-comments.jsonl
  releases.jsonl
  release-assets/
  discussions.jsonl
  projects.jsonl
  permissions.json
```

Retain raw API payloads where compliance or future schema migrations justify the
storage cost. Normalized records should include `schemaVersion`, `sourceUpdatedAt`,
`retrievedAt`, and the GitHub node/REST ID.

## 3. Durable data model

### `backup_runs`

```text
id, tenant_id, status, profile, source_type, source_name,
created_at, started_at, completed_at, extractor_version,
github_api_version, estimated_repos, discovered_repos,
completed_repos, partial_repos, failed_repos, bytes_uploaded,
error_code, error_message
```

### `repository_runs`

```text
id, run_id, owner, name, source_url, default_branch,
head_sha, status, stage, discovered_at, started_at, completed_at,
tree_truncated, clone_mode, retry_count, last_error, next_retry_at
```

### `artifacts`

```text
id, repository_run_id, kind, relative_path, source_sha,
size_bytes, content_type, sha256, status, destination,
destination_key, destination_version, verified_at,
attempt_count, last_error
```

### `checkpoints`

```text
repository_run_id, stage, cursor_or_page, last_source_id,
last_success_at, lease_owner, lease_expires_at
```

### Invariants

- A verified artifact is immutable.
- A repository cannot be `completed` while required artifacts are pending, partial,
  failed, or unverified.
- A retry uses the same idempotency key:
  `runId/repository/headSha/artifactKind/destination`.
- A corrupt state file is quarantined, never silently treated as an empty state.

## 4. Storage layout

```text
{tenant}/
  {source-type}/{source-name}/
    runs/{run-id}/
      run.json
      repositories/{owner}/{repo}/
        manifest.json
        repository.bundle
        refs.json
        checksums.sha256
        metadata/
          issues.jsonl
          pull-requests.jsonl
          releases.jsonl
      latest.json
```

Use object-store versioning and, for compliance profiles, object lock/retention.
`latest.json` is a pointer, never the only record of a run.

## 5. Adapter contract evolution

The current adapter contract is upload-only:

```ts
interface StorageAdapter {
  readonly name: string;
  upload(path: string, content: Buffer, contentType: string): Promise<void>;
}
```

The mature contract should add:

```ts
interface DurableStorageAdapter extends StorageAdapter {
  preflight(): Promise<{
    writable: boolean;
    versioning?: boolean;
    objectLock?: boolean;
    message?: string;
  }>;
  head(path: string): Promise<{
    exists: boolean;
    size?: number;
    etag?: string;
    versionId?: string;
  }>;
  verify(path: string, sha256: string): Promise<void>;
  delete?(path: string): Promise<void>;
}
```

Permanent errors (`NoSuchBucket`, invalid credentials, forbidden destination) must
be typed and fail preflight. Transient errors can use exponential backoff with jitter.

## 6. Web/API lifecycle

### Create

`POST /api/runs` validates input, creates a run, runs preflight, and returns `runId`.
It must not begin a multi-hour transfer in the request.

### Monitor

`GET /api/runs/{runId}` returns a summary. `GET /api/runs/{runId}/events` can use
SSE for live updates, but reconnecting clients must replay events from a cursor.

### Control

```text
POST /api/runs/{id}/pause
POST /api/runs/{id}/resume
POST /api/runs/{id}/cancel
POST /api/runs/{id}/retry
POST /api/runs/{id}/verify
```

### Restore

Restore must be a separate, explicit workflow with dry-run, destination confirmation,
approval, and a full result manifest.

## 7. Security model

- Prefer GitHub App installation tokens with least-privilege repository permissions
  over long-lived PATs.
- Keep provider credentials server-side in a managed secret store.
- Never write PATs, private keys, connection strings, or signed URLs to logs.
- The current browser-local persistence is convenient but exposes credentials to any
  code running in the same origin and to anyone using the device. Add a clear
  "remember credentials" choice and default secrets to session-only storage.
- Encrypt manifests when they contain private repository names, collaborator data,
  or access policy information.
- Audit preflight, run creation, pause/resume/cancel, restore, and credential changes.

## 8. Observability events

```text
run.created
run.preflight_failed
run.started
repository.discovered
repository.started
github.request
github.rate_limit_wait
artifact.upload_started
artifact.uploaded
artifact.verified
repository.partial
repository.failed
run.completed
run.partial
run.failed
restore.completed
```

Required dimensions: `runId`, `repository`, `stage`, `adapter`, `errorCode`, HTTP
status, retry count, duration, bytes, and rate-limit remaining. Do not include token
values or full authorization headers.

