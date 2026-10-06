# Detiq GCE Platform Maturity Roadmap

_Status: planning baseline · Updated 2026-10-06_

## 1. Product requirement

Detiq GCE should be a dependable GitHub organization backup platform, not only a file
copy utility. A successful backup must be:

1. **Complete** - code, refs, LFS objects, and selected GitHub metadata are captured.
2. **Resumable** - an interrupted run continues from durable checkpoints.
3. **Verifiable** - the platform can prove what was captured and uploaded.
4. **Restorable** - an operator can restore a repository or metadata set and test it.
5. **Observable** - a long run exposes progress, rate limits, failures, and a useful run ID.
6. **Safe** - credentials are not logged, destructive operations require confirmation,
   and destination retention is explicit.
7. **Scalable** - thousands of repositories do not depend on one long-lived Vercel
   request.

## 2. Evidence from the current deployment

The supplied Vercel log snapshot contains:

- `Found 4115 repos` for the `CondeNast` organization.
- Repeated file failures for every repository.
- Repeated metadata failures: `NoSuchBucket: The specified bucket does not exist.`
- A request model that performs the entire extraction inside one streamed
  `/api/extract` invocation.

This explains the two visible symptoms:

- A run appears stuck because enumerating and processing 4,115 repositories is a
  multi-hour workload, while a serverless request has a bounded execution time.
- Files fail because the configured R2 account, bucket, or credentials do not refer to
  an existing bucket. Retrying that error cannot fix it.

The dashboard now restores form configuration after refresh and includes the adapter
error in each failed-file log. Those are immediate UX fixes, not a replacement for a
durable job service.

## 3. Current capability map

| Area | Current state | Maturity | Required direction |
|---|---|---:|---|
| Repository discovery | REST pagination and filters | 2/5 | Persist cursors, budgets, and discovery snapshot |
| Code capture | File tree + blob API; CLI clone/bundle modes | 3/5 | Make mirror/bundle the default full-backup path |
| Git history | Available through CLI clone modes | 3/5 | Expose in web jobs and capture refs/LFS |
| Metadata | Issues, PRs, reviews/comments, releases/assets, wiki, labels, milestones | 3/5 | Add discussions, projects, hooks, advisories, gists |
| Storage | R2, S3, Drive, GitHub, Azure adapters | 3/5 | Preflight, per-destination status, checksums, versioning |
| Resume | Local JSON state in CLI | 2/5 | Versioned run manifest and durable job checkpoints |
| Incremental | File/repository SHA tracking | 2/5 | Record deletions, renames, metadata deltas, and restore points |
| Verification | No end-to-end restore verification | 1/5 | Hashes, destination checks, `git fsck`, sample restore |
| Web execution | One SSE serverless request | 1/5 | Queue-based asynchronous jobs |
| UX | Configuration form and live log | 2/5 | Job history, preflight, progress by repository, actionable errors |
| Security | PATs sent to API and browser persistence | 2/5 | Short-lived credentials, secret redaction, retention and audit controls |
| Operations | Text logs and cron endpoint | 2/5 | Structured events, metrics, alerts, dead-letter runs |

## 4. Target product surfaces

### 4.1 Create backup

The operator selects:

- GitHub source: organization/user, repository filters, visibility, forks, archives.
- Capture profile: `code`, `mirror`, `metadata`, `compliance`, or custom.
- Destination(s), retention, object versioning, and encryption policy.
- Concurrency and API budget.
- Schedule and notification destinations.

Before starting, the UI runs a **preflight**:

- validates the PAT scope and source access;
- lists the number of matching repositories;
- validates each destination bucket/container/folder;
- estimates API calls, bytes, and duration;
- warns if the run exceeds a serverless or API budget;
- requires explicit confirmation for large runs.

### 4.2 Run monitoring

Every run has a stable ID and displays:

- state: `queued`, `running`, `paused`, `completed`, `partial`, `failed`,
  `cancelled`;
- repositories discovered/completed/partial/failed;
- bytes and artifacts uploaded/verified;
- rate-limit remaining and next retry;
- current repository and stage;
- destination-specific failures;
- a downloadable manifest and structured log.

### 4.3 Verify and restore

Operators can:

- verify one repository, one run, or a destination;
- inspect missing, changed, or unverified artifacts;
- restore code to a local directory or new repository;
- restore metadata as JSON/JSONL;
- run a dry-run restore before writing anything;
- compare the restored refs and checksums with the manifest.

## 5. Phased delivery plan

### Phase 0 - Stabilize the current product

**Goal:** eliminate silent or repeated configuration failures.

- Add adapter preflight (`HeadBucket`, container existence, Drive folder access,
  GitHub target write permission).
- Classify errors as configuration, authentication, rate limit, transient, quota, or
  permanent object failure.
- Do not retry permanent errors such as `NoSuchBucket`.
- Add a run-level failure summary and error code.
- Cap or warn on large web runs; do not let a 4,000-repository run look like a
  browser problem.
- Persist the selected form locally with an explicit clear/reset action. Never print
  credential values.

**Acceptance criteria**

- A bad R2 bucket fails in preflight before the first repository upload.
- The UI shows the exact destination and remediation without exposing secrets.
- A disconnected browser does not mark a server-side job as failed.

### Phase 1 - Correctness and manifests

**Goal:** every successful run is auditable.

- Introduce a versioned `run.json`.
- Write one immutable repository manifest per repository.
- Store SHA-256, byte size, MIME type, source SHA/ref, destination, upload status,
  attempts, and verification timestamp.
- Mark recursive tree truncation as `partial` and require a mirror/bundle fallback.
- Track deleted and renamed files in incremental deltas.
- Capture the GitHub API version and extractor version.

**Acceptance criteria**

- A run cannot be `completed` if any repository is partial or unverified.
- A manifest can enumerate every artifact without reading application logs.
- A second run is idempotent for the same source SHA and destination.

### Phase 2 - Git-native capture

**Goal:** make large repository backup efficient and complete.

- Use `git clone --mirror` / `git fetch --prune` for full repository backups.
- Use bundles when a single portable artifact is preferred.
- Capture all refs and tags, not only the default branch.
- Detect and optionally fetch Git LFS objects.
- Retain API file extraction for selective exports and previews.

**Acceptance criteria**

- A mirrored repository passes `git fsck`.
- Refs before and after restore match the manifest.
- A repository with more than 100,000 tree entries is not silently incomplete.

### Phase 3 - Durable asynchronous jobs

**Goal:** remove the single-request Vercel execution bottleneck.

- Keep Next.js as the control plane only.
- Store jobs and run state in Postgres or another durable database.
- Queue one job per repository and child jobs per capture/destination stage.
- Use deterministic idempotency keys and leases.
- Add cancellation, pause/resume, retry, dead-letter, and operator retry.
- Use a worker runtime suitable for long jobs; Vercel may remain the UI/API layer.

**Acceptance criteria**

- A 4,115-repository organization is queued without one open browser request.
- A worker restart resumes without duplicate or missing artifacts.
- Each repository can be retried independently.

### Phase 4 - Metadata and compliance depth

- GitHub Discussions via GraphQL.
- Projects V2, sub-issues, milestones, labels, and issue timelines.
- Webhooks, hooks, collaborators, teams, permissions, branch protection, rulesets,
  deploy keys, environments, and security advisories where token scope allows.
- Gists and organization-level audit records where required.
- Raw payload retention plus normalized queryable records.
- Configurable retention, legal hold, object lock, encryption key ownership, and
  region/data residency policy.

### Phase 5 - Restore, observability, and ecosystem

- One-click restore plans with approval and dry-run.
- Scheduled verification and restore drills.
- OpenTelemetry traces and metrics.
- Slack/email/webhook notifications and SLO dashboards.
- Plugin interface for new source providers and destinations.
- GitLab and Bitbucket source support only after GitHub correctness is mature.

## 6. Prioritized backlog

| Priority | Deliverable | Why now | Definition of done |
|---|---|---|---|
| P0 | Destination preflight | Prevents the observed repeated `NoSuchBucket` failures | Every enabled adapter has a connectivity/write check |
| P0 | Async repository jobs | Prevents Vercel request timeouts | Browser only creates/monitors jobs |
| P0 | Run/repository manifests | Makes completeness measurable | Versioned manifest downloadable and queryable |
| P0 | Permanent/transient error policy | Stops useless retries | `NoSuchBucket` and auth errors fail fast |
| P1 | Mirror/bundle web profile | Avoids one API call per file | Large repos use Git transport |
| P1 | Hash and destination verification | Detects corrupt/partial uploads | Every artifact has checksum and verification status |
| P1 | Truncation hard-stop/fallback | Prevents false success | No truncated tree can be marked complete |
| P1 | Job history and retry UI | Makes operations recoverable | Retry one repo/stage without rerunning all |
| P2 | API budget/throttling | Protects PAT and job stability | Shared budget across all workers |
| P2 | Restore/verification CLI | Proves the backup is usable | CI-friendly restore smoke test |
| P2 | Structured logs/metrics | Enables incident response | Run/repo/artifact events are queryable |
| P3 | Compliance metadata and retention | Differentiates from simple cloners | Policy-driven archive and audit trail |

## 7. Non-goals and guardrails

- Do not treat raw object storage as a searchable database.
- Do not use Google Drive or a GitHub repository as the primary store for very large
  organizations.
- Do not add Redis/BullMQ before a durable manifest and idempotency model exists.
- Do not claim a backup is complete because all upload promises resolved.
- Do not persist credentials in a shared server-side database without encryption and
  explicit key management.

## 8. Success metrics

- 99.9% of repository artifacts in a completed run are checksum-verified.
- 0 silent partial repositories.
- 100% of permanent destination errors fail before bulk transfer.
- Median time to identify a failed repository is under 2 minutes.
- A worker restart loses 0 completed artifacts and duplicates 0 verified artifacts.
- A scheduled restore drill succeeds at least monthly.
- Large runs have no dependency on a connected browser tab.

