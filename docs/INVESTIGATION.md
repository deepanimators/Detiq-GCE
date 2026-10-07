# Investigation Notes

Running log of known issues, decisions, and future work.
Add new entries at top with status tag.

---

## Web Platform Investigations

The active web-platform investigation has been split into focused documents:

- [Worker queue and Vercel runtime](investigations/2026-10-07-worker-queue-and-vercel-runtime.md)
- [GitHub API rate limits and capture modes](investigations/2026-10-07-github-api-rate-limit-and-capture-modes.md)
- [Browser state, live log, and UX](investigations/2026-10-07-browser-state-live-log-and-ux.md)
- [Investigation-derived production backlog](investigations/2026-10-07-production-implementation-backlog.md)

Use these files with `TARGET_ARCHITECTURE.md`, `PLATFORM_MATURITY_ROADMAP.md`,
and `OPERATIONS_RUNBOOK.md` when implementing the next production slices.

---

## All Fixed Issues

### ✅ No retry on network/API failures
`src/retry.ts` — 4 attempts, exponential backoff. Rate-limit 429/403 → sleep until `x-ratelimit-reset`.

### ✅ No rate limit handling  
`src/retry.ts` + `src/github.ts` — detects limit, reads header, waits, resumes.

### ✅ No content-type on S3/R2/Azure uploads
`src/mime.ts` — 60+ extension mappings, fallback `application/octet-stream`. All adapters pass ContentType.

### ✅ GDrive folder creation race condition
`src/adapters/gdrive.ts` — promise-based dedup map. One in-flight create per path; concurrent callers await same promise.

### ✅ No skip-forks / skip-archived / visibility filters
`src/cli.ts` + `src/github.ts` — `--skip-forks`, `--skip-archived`, `--visibility public|private|all`.

### ✅ No exclude patterns
`src/extractor.ts` — built-in defaults (node_modules, dist, *.lock, etc.) + `--exclude "pattern1,pattern2"` + `--no-default-excludes`.

### ✅ No dry-run mode
`--dry-run` — enumerates files, logs counts, uploads nothing.

### ✅ No file size filter
`--max-file-size <kb>` + GitHub's own 100MB blob limit auto-applied.

### ✅ No config validation
`src/cli.ts` — exits early with clear per-adapter env var hints.

### ✅ No file logging
`src/logger.ts` — `--log-file <path>` writes alongside console. `DEBUG=1` for verbose.

### ✅ No progress bar
`src/progress.ts` — `cli-progress` multi-bar (repo + file). Auto-disabled in CI / non-TTY.

### ✅ No concurrency override at runtime
`--repo-concurrency <n>` and `--file-concurrency <n>`.

### ✅ No git history preservation (Gap 1)
`src/clone.ts` — `--clone-mode shallow|full|bundle`.
- `shallow` — `git clone --depth 1`, upload working tree
- `full` — full history clone, upload working tree
- `bundle` — `git clone --mirror` + `git bundle create --all` → single `.bundle` file per repo

### ✅ No metadata backup (Gap 2)
`src/metadata.ts` — `--metadata` flag enables:
- Issues + comments (`issueComments` via paginated `/issues/{n}/comments`)
- PRs + reviews + inline comments
- Releases + binary asset download (`releaseAssets` via `fetch` with Bearer auth)
- Wiki (clone `{repo}.wiki.git` → upload .md files; gracefully skipped if no wiki)
- Labels, Milestones

### ✅ No resume on interrupt (Gap 3)
`src/state.ts` — zero-native JSON state file. Tracks `(owner/repo/path, sha, adapters[])`. Skip on re-run. `--state-db path/to/state.json`.
Note: SQLite (`better-sqlite3`) rejected — doesn't compile on Node.js 23.x.

### ✅ No incremental sync (Gap 4)
`src/extractor.ts` + `src/github.ts` — `--incremental` (requires `--state-db`):
- Stores HEAD SHA per repo in state file
- On re-run: compare to current HEAD via GitHub compare API
- Only extracts changed files
- First run always full

### ✅ No repo name/topic filters (Gap 5)
`src/github.ts` — `--match <regex>` (case-insensitive) and `--topics tag1,tag2` (AND match).

### ✅ No progress bar (Gap 6)
`src/progress.ts` — covered above.

### ✅ No YAML config (Gap 7)
`src/config.ts` — auto-discovers `extractor.yaml` in cwd, or `EXTRACTOR_CONFIG=path`. YAML > .env priority.

### ✅ No scheduler (remaining gap 3)
`src/cli.ts` — `--schedule "0 */6 * * *"` using `node-cron`:
- Validates cron expression before starting
- Runs immediately on launch, then on schedule
- SIGINT/SIGTERM → graceful stop

### ✅ Issue comments + PR reviews (remaining gap 4)
`src/metadata.ts` — fetched via `parseMetadataTypes()`. Enabled when `--metadata` set:
- Issue comments: paginated `/issues/{n}/comments` per issue
- PR reviews: `/pulls/{n}/reviews` per PR
- PR inline comments: `/pulls/{n}/comments` per PR
- Concurrency limited to 5 concurrent per-item fetches

### ✅ Release binary assets (remaining gap 2)
`src/metadata.ts` — downloads `browser_download_url` with `Authorization: token {PAT}`. Upload to all adapters at `{base}/releases/assets/{tag}/{filename}`.

### ✅ Wiki backup (remaining gap 1)
`src/metadata.ts` — clones `{owner}/{repo}.wiki.git` → walks files → uploads to adapters at `{base}/wiki/{filename}`. Gracefully skips repos with no wiki (catches clone error).

---

## Open Issues

### GitHub Tree Truncation (very large repos)
**Symptom:** `[warn] Tree truncated` — files missing.
**Cause:** GitHub recursive tree API truncates at ~100,000 nodes.
**Workaround:** Use `--clone-mode shallow` instead — bypasses API, walks filesystem.
**Status:** Open. Use clone mode as workaround.

### GitHub Target Adapter — Slow for Large Repos
**Cause:** 2 API calls per file (GET to check SHA + PUT). 500-file repo = 1,000 calls.
**Recommendation:** Only use GitHub target for small repos (<200 files).
**Future fix:** Git Data API batch commit (create blobs → tree → commit in bulk).

### Binary Files in GitHub Target Repo
Not a bug — files upload correctly. GitHub UI can't preview binaries. No action needed.

### Issue Comments Rate Impact
Repos with 1,000+ issues and many comments per issue can consume thousands of extra API calls.
Mitigated by `p-limit(5)` for per-item fetches and auto-retry on rate limit.
Use `--metadata-types issues,prs,releases,labels,milestones` (without `issue-comments`, `pr-reviews`) to skip deep fetching.

---

## Rate Estimation Guide

| Scenario | Repos | Avg files | Metadata depth | Total calls | Est. @ 5k/hr |
|---|---|---|---|---|---|
| Small user, no metadata | 10 | 50 | — | 510 | < 4 min |
| Medium org, no metadata | 50 | 200 | — | 10,050 | ~2 hrs |
| Medium org + metadata | 50 | 200 | issues+comments | ~50,000+ | 10+ hrs |
| Large org | 200 | 300 | — | 60,200 | 12 hrs |

For large orgs: run with `--incremental` after first full run, or use `--clone-mode shallow` (bypasses file API limits).

---

## Future Work (Still Open)

- [ ] Discussions (GitHub GraphQL) — only python-github-backup covers this
- [ ] Git LFS support in clone mode (`git lfs pull` after clone)
- [ ] Gists backup (python-github-backup supports)
- [ ] Branch protection rules (Rewind SaaS covers)
- [ ] GitHub Projects V2 (Cloudback covers)
- [ ] Plugin hook system like ghorg's `--repo-filter-hook`
- [ ] GitLab / Bitbucket support
- [ ] GitHub target adapter: Git Data API batch commits
