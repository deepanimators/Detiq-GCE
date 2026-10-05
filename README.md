# GitHub Extractor

Extract all repos from a GitHub user or org → upload files + metadata to **multiple storage targets in parallel**.

## Features

| Feature | Flag |
|---|---|
| Parallel upload to 5 targets | auto |
| Git history (shallow / full / bundle) | `--clone-mode` |
| Metadata: issues+comments, PRs+reviews, releases+assets, wiki | `--metadata` |
| Resume on interrupt | `--state-db` |
| Incremental (only changed files) | `--incremental` |
| Built-in cron scheduler | `--schedule` |
| Repo name + topic filters | `--match`, `--topics` |
| Smart file excludes | `--exclude`, `--no-default-excludes` |
| Progress bar (TTY auto-detect) | auto |
| YAML config | `extractor.yaml` |
| Rate-limit handling + retry | auto |
| Dry-run | `--dry-run` |

## Storage Targets

| Target | SDK |
|---|---|
| Cloudflare R2 | `@aws-sdk/client-s3` (S3-compatible) |
| AWS S3 | `@aws-sdk/client-s3` |
| Google Drive | `googleapis` (service account) |
| GitHub repo | `@octokit/rest` (Contents API) |
| Azure Blob | `@azure/storage-blob` |

## Setup

```bash
npm install
cp .env.example .env          # or copy extractor.yaml.example → extractor.yaml
# Fill in GITHUB_PAT + at least one storage adapter
```

## Usage

```bash
# All repos for a user
npm run dev user <username> [flags]

# All repos for an org
npm run dev org <orgname> [flags]

# After build
npm run build
node dist/cli.js user <username> [flags]
node dist/cli.js org <orgname>  [flags]
```

## All Flags

```
Filtering:
  --skip-forks                Skip forked repos
  --skip-archived             Skip archived repos
  --visibility <type>         all | public | private (default: all)
  --match <regex>             Only repos whose name matches regex (case-insensitive)
  --topics <t1,t2>            Only repos with ALL listed topics

Files:
  --dry-run                   Enumerate without uploading
  --exclude <patterns>        Extra comma-separated exclude patterns
  --no-default-excludes       Disable built-in excludes (node_modules, dist, *.lock…)
  --max-file-size <kb>        Skip files larger than N KB
  --log-file <path>           Write all output to log file too

Clone mode (git instead of API):
  --clone-mode shallow        git clone --depth 1, upload working tree
  --clone-mode full           Full history clone, upload working tree
  --clone-mode bundle         git bundle --all → single .bundle file per repo

Metadata:
  --metadata                  Enable all metadata types (see below)
  --metadata-types <list>     Comma-separated subset:
                                issues, issue-comments
                                prs, pr-reviews, pr-comments
                                releases, release-assets
                                wiki, labels, milestones

Resume & Incremental:
  --state-db <path>           JSON state file for resume + incremental
  --incremental               Only extract changed files vs last run (needs --state-db)

Scheduler:
  --schedule <cron>           Run on cron schedule (runs immediately then on schedule)
                              Example: "0 */6 * * *" = every 6 hours

Concurrency:
  --repo-concurrency <n>      Parallel repos (default: REPO_CONCURRENCY env or 3)
  --file-concurrency <n>      Parallel files/repo (default: FILE_CONCURRENCY env or 10)
```

## Examples

```bash
# Dry run — see what would be extracted
node dist/cli.js org mycompany --dry-run

# Full backup: code + all metadata, resume-capable
node dist/cli.js org mycompany \
  --metadata \
  --state-db ./state.json \
  --skip-forks \
  --log-file extraction.log

# Incremental: only changed files + metadata since last run
node dist/cli.js org mycompany \
  --metadata \
  --state-db ./state.json \
  --incremental

# Full git history as bundles
node dist/cli.js org mycompany --clone-mode bundle

# Only TypeScript repos matching "backend"
node dist/cli.js org mycompany \
  --match "backend.*" \
  --topics "typescript"

# Schedule: run every 6 hours, incremental
node dist/cli.js org mycompany \
  --schedule "0 */6 * * *" \
  --state-db ./state.json \
  --incremental \
  --metadata

# Issues + PRs only (skip release assets for speed)
node dist/cli.js org mycompany \
  --metadata \
  --metadata-types "issues,issue-comments,prs,pr-reviews,labels,milestones"
```

## Config: YAML (recommended)

```bash
cp extractor.yaml.example extractor.yaml
# Edit extractor.yaml
node dist/cli.js org mycompany
```

YAML takes priority over `.env`. Auto-discovered as `extractor.yaml` in cwd, or `EXTRACTOR_CONFIG=/path/to/file.yaml`.

## Default Excludes

Disabled with `--no-default-excludes`:
```
node_modules/  .git/  dist/  build/  .next/  __pycache__/
.DS_Store  *.lock  *.min.js  *.min.css  *.map
```

## File Path in Storage

```
{owner}/{repo}/{filepath}
{owner}/{repo}/_metadata/issues.json
{owner}/{repo}/_metadata/pull_requests.json
{owner}/{repo}/_metadata/releases.json
{owner}/{repo}/_metadata/releases/assets/{tag}/{filename}
{owner}/{repo}/_metadata/wiki/{page.md}
{owner}/{repo}/_metadata/labels.json
{owner}/{repo}/_metadata/milestones.json
{owner}/{repo}/repo.bundle        ← when --clone-mode bundle
```

## Rate Limit Guidance

GitHub PAT: 5,000 requests/hour. Metadata with comments multiplies usage significantly.

| Config | Calls per repo |
|---|---|
| Files only | 1 + file_count |
| + metadata (no comments) | + ~5 API calls |
| + issue comments (100 issues) | + ~100-500 calls |
| + PR reviews (50 PRs) | + ~50-200 calls |

For orgs with 50+ repos: use `--incremental` after first run, or use `--clone-mode shallow` (bypasses per-file API calls).

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Adapters](docs/ADAPTERS.md)
- [Investigation Log](docs/INVESTIGATION.md)
- [Competitive Analysis](docs/COMPETITIVE_ANALYSIS.md)
