# Competitive Analysis — GitHub Codebase Extraction Tools

_Research verified via 101-agent deep sweep, 25 claims verified (21 confirmed, 4 refuted), 19 primary sources._
_Last updated: 2026-10-05_

---

## Market Map

| Tool | Type | Lang | Storage | Metadata | Cost |
|---|---|---|---|---|---|
| **This tool** | CLI | Node.js | R2, S3, Drive, GitHub, Azure | Issues, PRs, releases, labels, milestones | Free |
| ghorg | CLI | Go | Local disk only | Wiki only | Free |
| python-github-backup | CLI | Python | Local disk only | Full (best OSS) | Free |
| github-metadata-backup | CLI | Rust | Local disk only | Issues + PRs only | Free |
| github-backup-utils | CLI | Ruby | Local disk only | GHES-only, full | Free |
| gitea-mirror | SaaS/Self | TypeScript | Gitea/Forgejo | Issues, PRs, labels, releases, wiki | Free (self-host) |
| Rewind (BackHub) | SaaS | — | Vendor-managed | Full | ~$3/repo/month |
| Cloudback | SaaS | — | BYO (S3/Azure/GCS) | Full + LFS | $10/month (10 repos) |
| GitProtect | SaaS (Enterprise) | — | BYO | Full | Enterprise pricing |

---

## Tool Deep Dives (Verified)

---

### ghorg
**URL:** https://github.com/gabrie30/ghorg | **Stars:** ~4,000 | **Language:** Go

**Verified facts:**
- `--backup` uses `git clone --mirror` — full git history preserved
- Default **25 parallel clones** via `--concurrency` flag (auto-drops to 1 when `--clone-delay-seconds > 0`)
- Incremental: runs `git pull + git clean` on existing repos — no re-clone
- Built-in scheduling: `ghorg reclone-cron` and `ghorg reclone-server` subcommands
- Plugin system: `--repo-filter-hook` accepts any executable receiving repos as JSON stdin → returns filtered repos as JSON stdout
- **Does NOT backup issues, PRs, or any GitHub metadata** — only `--clone-wiki` for wikis

**Feature comparison:**

| Feature | ghorg | This tool |
|---|---|---|
| Platforms | GitHub, GitLab, Gitea, Bitbucket | GitHub only |
| Storage | Local disk only | R2, S3, Drive, GitHub, Azure |
| Parallel ops | 25 concurrent clones | Configurable (default 10 files/3 repos) |
| Git history | ✅ full mirror | ✅ `--clone-mode full` / `--clone-mode bundle` |
| Issues/PRs | ❌ | ✅ `--metadata` |
| Wiki | ✅ `--clone-wiki` | ❌ (next gap) |
| Resume | ✅ (re-run = git pull) | ✅ `--state-db` |
| Incremental | ✅ git pull | ✅ `--incremental` (HEAD SHA compare) |
| Scheduling | ✅ built-in cron server | ❌ |
| Plugin hooks | ✅ `--repo-filter-hook` | ❌ |
| Regex filter | ✅ `--match-regex` | ✅ `--match` |
| Topic filter | ✅ `--topics` | ✅ `--topics` |
| Progress bar | ✅ | ✅ |
| YAML config | ✅ `.ghorg` file | ✅ `extractor.yaml` |
| Cloud upload | ❌ | ✅ |

**ghorg advantage:** Multi-platform, mature, built-in cron server, git history, wiki, plugin hooks.
**Our advantage:** Cloud upload to 5 targets simultaneously, metadata backup, file-level filtering.

---

### python-github-backup
**URL:** https://github.com/josegonzalez/python-github-backup | **Version:** 0.65.1

**Verified facts — most comprehensive OSS metadata tool:**
- Covers: issues (with comments, events, timeline), PRs (reviews, commits, comments), discussions (GraphQL), releases with binary assets, wikis, gists, labels, hooks, milestones, security advisories, binary attachments
- Two incremental modes:
  - `--incremental` — API checkpoint via per-resource `last_update` files
  - `--incremental-by-files` — filesystem mtime-based
- Auto-throttles on `retry-after` / `x-ratelimit-reset` headers (same approach as this tool)
- Manual controls: `--throttle-limit` (pause when N requests remain) and `--throttle-pause` (sleep seconds)

**Feature comparison:**

| Feature | python-github-backup | This tool |
|---|---|---|
| Issues (with comments/timeline) | ✅ | ✅ (comments: next gap) |
| PRs (with reviews/commits) | ✅ | ✅ (reviews: next gap) |
| Discussions (GraphQL) | ✅ | ❌ |
| Releases (with binary assets) | ✅ | ✅ (binaries: next gap) |
| Wiki | ✅ | ❌ |
| Gists | ✅ | ❌ |
| Hooks | ✅ | ❌ |
| Security advisories | ✅ | ❌ |
| Cloud storage | ❌ local only | ✅ |
| Parallel repos | ❌ sequential | ✅ |
| Multi-target upload | ❌ | ✅ |
| Rate limit handling | ✅ auto-throttle | ✅ auto-retry |
| Incremental | ✅ two modes | ✅ HEAD SHA compare |

**python-github-backup advantage:** Deepest metadata coverage in OSS (discussions, gists, hooks, security advisories). Best choice for compliance-grade local backup.
**Our advantage:** Cloud upload to multiple targets, parallel extraction, file-level filtering.

---

### github-metadata-backup (0xB10C)
**URL:** https://github.com/0xB10C/github-metadata-backup | **Language:** Rust

**Verified facts:**
- Backs up **only issues and PRs** as JSON files in `issues/` and `pulls/` subdirectories
- Incremental via `state.json` — tracks last-seen records, only downloads new/modified
- **Does NOT automatically handle rate limits** — hits limit and blocks without backoff (refuted claim in our research)

Narrow tool, not a real competitor.

---

### github-backup-utils (GitHub's official)
**URL:** https://github.com/github/backup-utils

**Verified facts:**
- Targets **GitHub Enterprise Server ONLY** — does not work with GitHub.com or GitHub Enterprise Cloud
- Covers: Git repos, wikis, Gists, MySQL, Redis, Elasticsearch, SSH keys, audit logs
- **Being deprecated starting GHES 3.22**

Not relevant to this tool's use case.

---

### gitea-mirror (RayLabsHQ)
**URL:** https://github.com/RayLabsHQ/gitea-mirror

**Verified facts:**
- Mirrors code + metadata: issues (with comments/labels), PRs (as issues — Gitea API limitation), labels, milestones, releases (with assets), wiki
- Target: Gitea/Forgejo instances only
- Note: Multi-source platform claim (GitHub, GitLab, Gitea as sources) was **refuted 0-3** in research — source support is more limited than marketing suggests

Different category — this is a GitHub→Gitea migration tool, not a general backup tool.

---

### Rewind (acquired BackHub)
**URL:** https://rewind.com/products/backups/github

**Verified facts:**
- Automated nightly backups + on-demand "Backup Now"
- Covers: PRs, issues, wikis, milestones, labels, releases, branch protection rules, rulesets
- Retention: 30 days (Pro/Individual), 365 days (Enterprise)
- Self-serve restore on all tiers
- **Vendor-managed storage** — users have NO control over backup destination (refuted claim that it supports BYO storage)
- Note: PRs are restored as issues due to GitHub API limitations

**Feature comparison:**

| Feature | Rewind | This tool |
|---|---|---|
| Metadata (full) | ✅ | ✅ issues/PRs/releases/labels/milestones |
| Branch protection, rulesets | ✅ | ❌ |
| Automated scheduling | ✅ | ❌ |
| Point-in-time restore | ✅ | ❌ |
| Storage control | ❌ vendor-managed | ✅ your cloud |
| Data sovereignty | ❌ | ✅ |
| Self-hosted | ❌ | ✅ |
| Setup time | 5 min (OAuth) | ~30 min |
| Pricing | ~$3/repo/month | Free |

**Rewind advantage:** Zero maintenance, scheduling, restore UI, branch protection backup.
**Our advantage:** Free, your storage, full code control, data sovereignty.

---

### Cloudback
**URL:** https://cloudback.it

**Verified pricing:**
- Free: 1 repo, 100MB storage
- Basic: $10/month (10 repos)
- Team: $75/month (100 repos)
- Enterprise: $500/month (1,000 repos)

**Verified features:**
- Full GitHub metadata: issues, PRs, labels, milestones, projects (V2), wiki, releases, webhooks, collaborators, Git LFS
- Format: **ZIP archives** containing cloneable git repo + JSON metadata files
- BYO storage: S3, Azure, GCS (unlike Rewind)
- Projects V2 and sub-issues added 2024

**Feature comparison:**

| Feature | Cloudback | This tool |
|---|---|---|
| Metadata (full) | ✅ + Projects V2 + LFS | ✅ partial (no Projects, LFS) |
| BYO storage | ✅ S3/Azure/GCS | ✅ R2/S3/Drive/GitHub/Azure |
| R2 support | ❌ | ✅ |
| Google Drive | ❌ | ✅ |
| GitHub target repo | ❌ | ✅ |
| Output format | ZIP archives | Raw files (no zip) |
| Scheduling | ✅ | ❌ |
| UI | ✅ | ❌ CLI only |
| Pricing | $10/month+ | Free |

**Cloudback advantage:** Full metadata including Projects V2, LFS, scheduling, UI.
**Our advantage:** Free, more storage targets (R2, Drive, GitHub), raw files not ZIPs, file-level filtering.

---

## Complete Feature Matrix

| Feature | **This tool** | ghorg | py-github-backup | Rewind | Cloudback |
|---|---|---|---|---|---|
| **Code files** | ✅ API + clone | ✅ git only | ✅ git only | ✅ | ✅ |
| **Git history** | ✅ `--clone-mode` | ✅ | ✅ | ✅ | ✅ |
| **Issues** | ✅ | ❌ | ✅ deep | ✅ | ✅ |
| **Pull Requests** | ✅ | ❌ | ✅ deep | ✅ | ✅ |
| **Releases** | ✅ | ❌ | ✅ + assets | ✅ | ✅ |
| **Labels** | ✅ | ❌ | ✅ | ✅ | ✅ |
| **Milestones** | ✅ | ❌ | ✅ | ✅ | ✅ |
| **Wiki** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Discussions** | ❌ | ❌ | ✅ GraphQL | ? | ❌ |
| **Gists** | ❌ | ❌ | ✅ | ❌ | ❌ |
| **Hooks/Webhooks** | ❌ | ❌ | ✅ | ❌ | ✅ |
| **Security advisories** | ❌ | ❌ | ✅ | ❌ | ❌ |
| **LFS** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Projects V2** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Branch protection** | ❌ | ❌ | ❌ | ✅ | ❌ |
| **Cloudflare R2** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **AWS S3** | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Google Drive** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Azure Blob** | ✅ | ❌ | ❌ | ❌ | ✅ |
| **GitHub target repo** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Parallel multi-target** | ✅ | N/A | N/A | N/A | N/A |
| **Retry + backoff** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Rate limit handling** | ✅ header-based | ✅ | ✅ header-based | ✅ | ✅ |
| **Resume on interrupt** | ✅ state DB | ✅ (re-run) | ✅ | ✅ | ✅ |
| **Incremental sync** | ✅ HEAD SHA | ✅ git pull | ✅ two modes | ✅ | ✅ |
| **Skip forks/archived** | ✅ | ✅ | ✅ | N/A | N/A |
| **Regex repo filter** | ✅ `--match` | ✅ | ❌ | N/A | N/A |
| **Topic filter** | ✅ `--topics` | ✅ | ❌ | N/A | N/A |
| **Exclude patterns** | ✅ | N/A | N/A | N/A | N/A |
| **File size filter** | ✅ | N/A | N/A | N/A | N/A |
| **MIME types on upload** | ✅ | N/A | N/A | N/A | N/A |
| **Dry-run** | ✅ | ✅ | ❌ | N/A | N/A |
| **YAML config** | ✅ | ✅ | ❌ | N/A | N/A |
| **Progress bar** | ✅ | ✅ | ❌ | N/A | N/A |
| **Log to file** | ✅ | ❌ | ❌ | N/A | N/A |
| **Scheduling** | ❌ | ✅ built-in | ❌ | ✅ | ✅ |
| **Plugin hooks** | ❌ | ✅ | ❌ | N/A | N/A |
| **Self-hosted** | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Cost** | Free | Free | Free | ~$3/repo/month | $10/month (10 repos) |

---

## Remaining Gaps (Prioritized by Market Coverage)

### P0 — High Coverage in Competitors

**Wiki backup**
ghorg, python-github-backup, Rewind, Cloudback all support it.
**Fix:** Clone `{repo}.wiki.git` via `simple-git` in `metadata.ts` → upload `.md` files.
**Effort:** 2 hours.

**Release binary assets**
python-github-backup and Cloudback download release assets (executables, archives).
**Fix:** In `metadata.ts` releases endpoint → download `browser_download_url` → upload to adapters.
**Effort:** 2 hours.

### P1 — Differentiators Worth Building

**Built-in scheduling**
ghorg has `reclone-cron` and `reclone-server` built-in. We have nothing.
**Fix:** Add `schedule <cron-expression> <command>` subcommand using `node-cron`.
**Effort:** 4 hours.

**Issue comments + PR reviews**
python-github-backup fetches issue comments, PR reviews, and PR commits individually.
Our metadata backup gets top-level issues/PRs only — no comments/reviews.
**Fix:** In `metadata.ts`, paginate `/issues/{n}/comments` and `/pulls/{n}/reviews` per item.
**Effort:** 3 hours.

### P2 — Niche but Notable

**Discussions (GraphQL)**
Only python-github-backup covers this. Requires GitHub GraphQL API.
**Effort:** Medium (4 hours). Lower priority.

**Git LFS**
Cloudback supports LFS. Our clone mode (`--clone-mode full`) passes `--depth 1` which doesn't fetch LFS objects.
**Fix:** Add `--lfs` flag that runs `git lfs pull` after clone.
**Effort:** 1 hour.

**Plugin hook system**
ghorg's `--repo-filter-hook` is powerful. Let external scripts filter repos.
**Effort:** Medium (4 hours).

### P3 — Low Priority

- Gists backup (python-github-backup)
- Webhook/hook backup (python-github-backup, Cloudback)
- Security advisories (python-github-backup)
- GitHub Projects V2 (Cloudback)
- Branch protection rules (Rewind)

---

## Positioning

**Best for:** Teams who want raw files in their own cloud storage (R2, S3, Azure, Drive) with no SaaS vendor, plus metadata backup and file-level filtering. No other OSS tool combines cloud upload + metadata.

**Not best for:**
- Need git history on local disk → use **ghorg** (`git clone --mirror`)
- Need deepest metadata (discussions, gists, advisories) → use **python-github-backup**
- Need zero-maintenance + restore UI → use **Rewind**
- Need Projects V2 + LFS + scheduling UI → use **Cloudback**
