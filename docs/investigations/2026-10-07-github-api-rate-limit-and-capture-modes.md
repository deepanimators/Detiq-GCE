# Investigation: GitHub API Rate Limits and Capture Modes

_Status: active · Updated 2026-10-07_

## Symptoms observed

Vercel logs showed repeated GitHub 403s during source discovery and file capture:

```text
GET /orgs/tucdesk/repos?per_page=100&page=1&type=all - 403
GET /repos/TucDesk/TucDesk-original/git/blobs/{sha} - 403
GET /repos/TucDesk/Tucdesk/git/trees/main?recursive=1 - 403
```

The UI then reported:

```text
GitHub rate limit exhausted (403). Wait for the reset window and retry.
```

The important distinction: a 403 from GitHub can mean multiple things. In this
platform it can be:

- primary REST API rate limit exhausted;
- secondary/concurrency rate limiting;
- missing repository access;
- organization SSO not authorized for the token;
- token expired or revoked;
- private repository not visible to the token.

The current formatter in `web/src/lib/github.ts` separates those cases when GitHub
provides enough headers.

## Current extraction behavior

Relevant files:

- `web/src/lib/github.ts`
- `web/src/lib/extractor.ts`
- `web/src/lib/metadata.ts`
- `web/src/lib/runs/worker.ts`

The web extractor currently performs code backup through the GitHub REST API:

1. List repositories.
2. Fetch the recursive Git tree for each repository branch.
3. For each blob, call GitHub's blob API.
4. Upload each file to each configured destination.

This is **selective API mode**, even if the UI currently presents it as the main
backup path.

The recent resume improvement checks destination objects before downloading a blob.
That prevents re-copying files that already landed in storage, but it does not avoid
GitHub API usage for new or missing files.

## Why this fails for full backups

REST tree/blob backup scales with file count:

```text
repository listing calls
+ one recursive tree call per repository
+ one blob call per copied file
+ metadata pagination calls when metadata is enabled
```

For a repository with thousands of files, the REST blob path can exhaust the token's
hourly budget quickly. Metadata deep capture can multiply the problem because issues,
comments, PR reviews, release assets, and timelines are separate paginated surfaces.

GitHub exposes reset timing through rate-limit headers. The correct behavior after
primary exhaustion is to pause until the reset window instead of hammering the API.
The worker now requeues rate-limited runs with `availableAt`.

## Capture mode split

Production should expose three clear modes.

| Mode | Default use | GitHub surface | Output | Rate-limit profile |
|---|---|---|---|---|
| Mirror bundle | Full code backup | Git transport (`git clone --mirror`, `git bundle`) | `repository.bundle`, refs, manifest, checksums | Avoids one REST call per file; still may be throttled by GitHub service and runtime limits. |
| Selective API | Small filtered exports and previews | REST tree/blob API | Individual files/folders | Easy to filter, but high API cost for large repos. |
| Metadata | Issues, PRs, releases, labels, milestones, assets | REST/GraphQL APIs | JSON/JSONL plus binary assets | Still API-limited; must be paginated, throttled, and checkpointed. |

Mirror bundle should be the default for full backups. Selective API mode should be
kept because it supports filters that Git transport does not naturally provide.
Metadata should be optional and preferably run after code capture succeeds.

## Does mirror mode remove all limits?

No. Mirror mode removes the **REST per-file/blob call pattern**. It does not make
GitHub unlimited.

Remaining limits and constraints:

- GitHub can still throttle abusive or very heavy Git traffic.
- Private repository access still depends on token/app permissions and SSO approval.
- Git LFS uses its own transfer path and must be captured deliberately.
- The worker runtime needs enough wall time, disk, memory, and network bandwidth.
- Current adapters accept `Buffer` uploads, so very large bundle artifacts need
  streaming upload support before the system is truly production-grade for large
  repositories.

## Authentication direction

### Current PAT flow

The current web UI accepts a Personal Access Token and sends it to server routes for
the run. This is simple but weak for production because:

- users can paste tokens with broader permissions than required;
- localStorage credential saving is convenient but risky on shared devices;
- organization SSO approval can be missed;
- token expiration and revocation are user-managed.

### OAuth

OAuth can support user-authorized access to organization repositories when the user
has access and grants the required scopes. It improves onboarding compared with
pasted PATs, but OAuth user tokens still share user-level API limits and depend on
the user's organization access.

OAuth is useful for:

- sign-in and user identity;
- small user-owned backups;
- letting a user authorize the app without pasting a token.

OAuth is not the best primary model for organization-scale backup automation.

### GitHub App

A GitHub App installation is the preferred production model:

- installation tokens are short-lived;
- permissions can be repository-scoped and least-privilege;
- organization owners can install and approve access centrally;
- GitHub App installation rate limits can scale with repository and organization
  size, subject to GitHub's documented caps.

Minimum app permissions for the target product should be designed by capture mode:

| Capability | Likely permission |
|---|---|
| Mirror private code | Repository contents read |
| Repository metadata | Metadata read |
| Issues and comments | Issues read |
| Pull requests/reviews/comments | Pull requests read |
| Releases/assets | Contents read |
| Branch protection/rulesets | Administration or rules metadata permissions where available |
| Teams/collaborators | Organization/member permissions where available |

Final permission names must be verified against GitHub's current app permission UI
before implementation.

## Required implementation changes

1. Add an explicit `captureMode` request field:

```ts
type CaptureMode = 'mirror' | 'selective-api' | 'metadata-only';
```

2. Add UI controls that make the trade-off visible:

- **Mirror bundle**: recommended full backup.
- **Selective files**: filtered file copy.
- **Metadata only**: no code files.

3. Route extraction by mode:

- mirror mode uses Git clone/bundle and uploads artifacts;
- selective mode uses existing tree/blob logic;
- metadata-only mode skips file capture and only writes metadata artifacts.

4. Add a streaming-capable adapter contract before allowing large bundles:

```ts
uploadStream(path, stream, contentType, sizeBytes?)
```

5. Store a repository manifest for every mode with:

- source repository;
- default branch;
- head SHA or refs;
- artifact list;
- checksums;
- warnings;
- capture mode;
- metadata types captured.

6. Keep rate-limit pause/requeue behavior for all REST metadata stages.

## Immediate operator guidance

- For full repository backup, do not use selective API mode on large repositories.
- Turn off deep metadata until code capture is complete.
- Lower file concurrency if secondary rate limits appear.
- Wait until the displayed reset time before retrying a rate-limited run.
- Prefer GitHub App installation tokens for organization backups.

## Official references checked

- GitHub REST API rate limits:
  `https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api`
- GitHub REST API best practices:
  `https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api`
- GitHub OAuth app authorization:
  `https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps`
- GitHub OAuth app rate limits:
  `https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/rate-limits-for-oauth-apps`
