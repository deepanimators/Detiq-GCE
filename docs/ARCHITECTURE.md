# Architecture

## System Overview

```
CLI (user|org command + flags)
        │
        ├── validateConfig()      → exit early if PAT/adapters missing
        ├── Logger.init()         → console + optional file output
        ▼
GitHubClient
  ├── listUserRepos / listOrgRepos
  │     ├── Manual pagination (per_page=100)
  │     ├── withRetry (4 attempts, exponential backoff)
  │     ├── Rate-limit detection → wait for x-ratelimit-reset
  │     └── Filter: visibility, skip-forks, skip-archived
  │
  ├── getFileTree (recursive, withRetry)
  │     └── Auto-filter: blobs only, size < 100MB
  │
  └── getFileContent (blob SHA → Buffer, withRetry)

        │  per file (p-limit concurrency)
        ▼
ExtractAll
  ├── p-limit(repoConcurrency)        → N repos in parallel
  ├── Exclude pattern matching         → skip node_modules, dist, etc.
  ├── Max file size filter             → skip oversized files
  ├── Dry-run mode                     → enumerate without uploading
  └── per repo: p-limit(fileConcurrency)
        │  per file
        ├── getFileContent()           → Buffer (downloaded once)
        ├── getMimeType(path)          → content-type string
        └── Promise.all([...adapters]) → ALL adapters simultaneously

Adapters:
  ├── R2Adapter           (S3-compatible, ContentType set)
  ├── S3Adapter           (native AWS, ContentType set)
  ├── GDriveAdapter       (service account, folder dedup via promise cache)
  ├── GitHubTargetAdapter (Contents API, auto-detect existing SHA)
  └── AzureAdapter        (Blob, blobContentType header set)
```

## File Path Convention

All storage targets receive files at:
```
{owner}/{repo}/{filepath}
```

Example: `acme-org/backend-api/src/controllers/auth.ts`

## Concurrency Model

| Variable           | Default | Controls                          |
|--------------------|---------|-----------------------------------|
| `REPO_CONCURRENCY` | 3       | Repos processed simultaneously    |
| `FILE_CONCURRENCY` | 10      | Files downloaded per repo at once |

Overridable at runtime via `--repo-concurrency` and `--file-concurrency` flags.

Each file is downloaded once from GitHub, then uploaded to all adapters simultaneously via `Promise.all`.

## Retry & Rate Limiting

`src/retry.ts` wraps every GitHub API call:
- 4 attempts max
- Exponential backoff (1s, 2s, 4s) for transient errors
- On 429/403: reads `x-ratelimit-reset` header → sleeps until reset + 2s buffer
- Falls back to 60s wait if reset header is absent

## Exclude Patterns

Built-in defaults (can disable with `--no-default-excludes`):
```
node_modules/  .git/  dist/  build/  .next/
__pycache__/  .DS_Store  *.lock  *.min.js  *.min.css  *.map
```

Custom patterns via `--exclude "vendor/,*.generated.ts"`.

Pattern matching in `src/extractor.ts` supports:
- Prefix: `node_modules/` → path starts with `node_modules/`
- Suffix: `*.lock` → path ends with `.lock`
- Contains: `**/*.min.js` → path contains `.min.js`
- Exact: `some/specific/file.ts`

## GitHub API Usage

| Operation           | Endpoint                                          | Rate cost |
|---------------------|---------------------------------------------------|-----------|
| List repos (page)   | `GET /users/{u}/repos` or `/orgs/{o}/repos`       | 1/page    |
| Get file tree       | `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`  | 1/repo    |
| Get file content    | `GET /repos/{o}/{r}/git/blobs/{sha}`              | 1/file    |

GitHub PAT rate limit: **5,000 requests/hour**.

Rate estimation: `repos + repos × avg_files_per_repo` requests total.

## Adapter Interface

```typescript
interface StorageAdapter {
  readonly name: string;
  upload(storagePath: string, content: Buffer, contentType: string): Promise<void>;
}
```

Adding a new adapter: implement interface → register in `src/adapters/index.ts` → add config in `src/config.ts`.

## Error Handling

- Per-file failures: logged as warn, counted in summary
- Per-repo failures: logged as error, other repos continue
- Final summary: total repos, uploaded/skipped/failed file counts
- Exit code 1 on config validation failure
