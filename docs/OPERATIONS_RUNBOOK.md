# Detiq GCE Operations Runbook

## 1. First response to a failed run

1. Copy the run ID and preserve the structured log.
2. Identify whether the failure is in discovery, GitHub API, capture, upload,
   metadata, verification, or restore.
3. Check the repository count and estimated API calls.
4. Check destination preflight before retrying.
5. Retry only failed repositories or stages; do not blindly restart the full org.

## 2. The observed R2 failure

### Symptom

The log repeats:

```text
NoSuchBucket: The specified bucket does not exist.
```

### Meaning

The request reached an S3-compatible endpoint, but the configured bucket is not
available in that account/endpoint. Common causes:

- wrong `R2_ACCOUNT_ID`;
- bucket name typo or deleted bucket;
- access key belongs to a different Cloudflare account;
- endpoint and account ID do not match;
- bucket exists but the token lacks permission;
- the Vercel deployment has stale environment variables.

### Safe remediation

1. Confirm the bucket exists in the same Cloudflare account as the account ID.
2. Confirm the R2 API token has object read/write permission for that bucket.
3. Confirm Vercel Production environment variables, not only local `.env`.
4. Redeploy after changing Vercel variables.
5. Run adapter preflight or a one-object test before starting an organization run.
6. Revoke and rotate credentials if they were pasted into an unsafe location.

Do not retry thousands of files while `NoSuchBucket` is present. It is a permanent
configuration failure.

## 3. The observed “stuck” run

### Symptom

The UI remains `Running` after showing repository discovery or shows no new log
lines for a long time.

### Meaning

The supplied run discovered 4,115 repositories. The web route currently performs
the whole operation inside one SSE request. This is unsuitable for a long-running
organization backup because:

- serverless execution has a platform timeout;
- the browser connection can close without cancelling the worker;
- a retry can duplicate work;
- progress is not durable if the process is killed.

### Immediate workaround

- run a small filtered scope first (`--match`, topics, visibility, or a selected
  repository set);
- disable deep comments/reviews for the first code capture;
- validate one destination with a dry run;
- use the CLI clone/bundle path for a large full backup;
- do not increase concurrency until the destination and rate budget are healthy.

### Correct fix

Move extraction to a durable asynchronous job worker. The browser should create and
monitor a job, not keep the extraction inside `/api/extract`.

## 4. Run profiles

| Profile | Use | Capture | Recommended destination |
|---|---|---|---|
| `preview` | Validate filters and credentials | discovery/tree counts only | none |
| `selective` | Small filtered export | API files and selected metadata | S3/R2 |
| `full-mirror` | Complete code backup | mirror/bundle, refs, LFS | versioned object storage |
| `metadata` | Metadata archive | JSONL/JSON endpoints | versioned object storage |
| `compliance` | Auditable retention | full-mirror + metadata + checksums + lock | object lock/WORM storage |
| `restore-test` | Prove usability | sample restore and verification | isolated restore target |

## 5. Retry policy

| Error class | Example | Action |
|---|---|---|
| Configuration | `NoSuchBucket` | Fail fast; operator fixes config |
| Authentication | 401/403 invalid token | Stop affected stage; rotate/fix scope |
| Rate limit | 429 or exhausted GitHub budget | Wait until reset; resume checkpoint |
| Transient network | timeout, 502, connection reset | Exponential backoff with jitter |
| Source missing | repository deleted/renamed | Mark repository unavailable; continue |
| Data correctness | truncated tree, checksum mismatch | Mark partial; fallback or operator review |
| Destination quota | storage full, Drive quota | Pause destination; notify operator |

## 6. Preflight checklist

- [ ] GitHub token has the required repository/org permissions.
- [ ] Organization name and filters produce the expected repository count.
- [ ] API budget estimate is within the token’s rate limit.
- [ ] Every enabled destination exists and is writable.
- [ ] Destination versioning/retention settings are known.
- [ ] At least one test artifact can be uploaded and read back.
- [ ] Full-mirror mode is selected for large repositories.
- [ ] Metadata depth is intentional; comments/reviews can multiply API calls.
- [ ] A run ID and notification target are configured.
- [ ] Restore destination is separate from the source.

## 7. Completion checklist

- [ ] Every required repository is `completed`, not merely attempted.
- [ ] No repository has `tree_truncated`, `partial`, or `unverified` status.
- [ ] Checksums match destination objects.
- [ ] Run manifest and error report are retained.
- [ ] Rate-limit and retry metrics show no unresolved backlog.
- [ ] A sample repository passes clone and `git fsck`.
- [ ] Metadata JSON/JSONL parses and has retrieval timestamps.
- [ ] Notification reports success, partial, or failure accurately.

## 8. Incident record template

```text
Run ID:
Started / ended:
Source:
Profile:
Repositories discovered / completed / partial / failed:
Destination(s):
First error code:
First failing repository:
Rate-limit observations:
Retries:
Data at risk:
Immediate mitigation:
Permanent fix:
Restore verification:
```

