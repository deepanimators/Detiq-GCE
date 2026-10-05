# Storage Adapters

Adapters are enabled only when all required env vars are present. Configure in `.env`.

---

## Cloudflare R2

Uses S3-compatible API via `@aws-sdk/client-s3`.

```env
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-r2-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret
R2_BUCKET=your-bucket-name
```

**Get credentials:** Cloudflare Dashboard → R2 → Manage R2 API tokens

---

## AWS S3

```env
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=your-bucket-name
```

**Get credentials:** AWS Console → IAM → Create user with `s3:PutObject` policy

---

## Google Drive (Service Account)

Uses a service account for server-to-server auth (no OAuth browser flow).

```env
GDRIVE_CLIENT_EMAIL=your-sa@project.iam.gserviceaccount.com
GDRIVE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GDRIVE_ROOT_FOLDER_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs
```

**Setup:**
1. GCP Console → IAM → Service Accounts → Create
2. Create key → JSON → extract `client_email` and `private_key`
3. Share your target Drive folder with the service account email (Editor)
4. Copy the folder ID from the URL: `drive.google.com/drive/folders/{FOLDER_ID}`

**Note:** `GDRIVE_PRIVATE_KEY` newlines must be literal `\n` in `.env` (the config auto-converts).

---

## GitHub Target Repo

Commits extracted files into a target GitHub repo using the Contents API.

```env
GITHUB_TARGET_OWNER=your-org-or-username
GITHUB_TARGET_REPO=code-backup
GITHUB_TARGET_BRANCH=main
```

Uses the same `GITHUB_PAT` as the source.

**Note:** GitHub target adapter is **slow** for large repos — each file = 1 API call (check + create/update). Best for small repos or selective extraction. For large repos, prefer R2/S3.

---

## Azure Blob Storage

```env
AZURE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
AZURE_CONTAINER=github-backups
```

**Get connection string:** Azure Portal → Storage Account → Access keys → Connection string

Container is created automatically if it doesn't exist.

---

## Adding a New Adapter

1. Create `src/adapters/my-adapter.ts`:

```typescript
import type { StorageAdapter } from './base.js';

export class MyAdapter implements StorageAdapter {
  readonly name = 'my-adapter';

  constructor(cfg: { /* your config */ }) { ... }

  async upload(storagePath: string, content: Buffer): Promise<void> {
    // implement upload
  }
}
```

2. Add config detection in `src/config.ts` (check required env vars)

3. Register in `src/adapters/index.ts`:

```typescript
if (config.myAdapter) {
  adapters.push(new MyAdapter(config.myAdapter));
  console.log('[adapter] MyAdapter enabled');
}
```
