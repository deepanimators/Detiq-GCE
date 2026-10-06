'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';

// ── Types ─────────────────────────────────────────────────────────────────────

type AdapterConfig = {
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  s3?: { region: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  gdrive?: { clientEmail: string; privateKey: string; rootFolderId: string };
  githubTarget?: { owner: string; repo: string; branch: string; pat: string };
  azure?: { connectionString: string; container: string };
};

type Summary = {
  totalRepos: number; successRepos: number;
  totalFiles: number; uploadedFiles: number;
  skippedFiles: number; failedFiles: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, type = 'text', mono = false,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; mono?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}

function Textarea({
  label, value, onChange, placeholder, rows = 4,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; rows?: number;
}) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900 font-mono resize-none"
      />
    </div>
  );
}

function AdapterToggle({
  id, label, logo, enabled, onToggle, children,
}: {
  id: string; label: string; logo: string; enabled: boolean;
  onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border transition-colors ${enabled ? 'border-zinc-900 dark:border-zinc-100 bg-white dark:bg-zinc-900' : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50'}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="text-base">{logo}</span>
          <span className={`text-sm font-medium ${enabled ? 'text-zinc-900 dark:text-zinc-50' : 'text-zinc-500'}`}>{label}</span>
        </span>
        <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 transition-colors ${enabled ? 'bg-zinc-900 dark:bg-zinc-50 border-zinc-900 dark:border-zinc-50' : 'border-zinc-300 dark:border-zinc-600'}`} />
      </button>
      {enabled && (
        <div className="px-4 pb-4 space-y-3 border-t border-zinc-100 dark:border-zinc-800 pt-3">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Home() {
  // Source
  const [pat, setPat] = useState('');
  const [targetType, setTargetType] = useState<'user' | 'org'>('org');
  const [targetName, setTargetName] = useState('');
  const [skipForks, setSkipForks] = useState(false);
  const [skipArchived, setSkipArchived] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [matchRegex, setMatchRegex] = useState('');
  const [maxFileSizeKb, setMaxFileSizeKb] = useState('');

  // Adapter toggles
  const [r2On, setR2On] = useState(false);
  const [s3On, setS3On] = useState(false);
  const [gdriveOn, setGdriveOn] = useState(false);
  const [ghOn, setGhOn] = useState(false);
  const [azureOn, setAzureOn] = useState(false);

  // R2
  const [r2AccountId, setR2AccountId] = useState('');
  const [r2AccessKey, setR2AccessKey] = useState('');
  const [r2SecretKey, setR2SecretKey] = useState('');
  const [r2Bucket, setR2Bucket] = useState('');

  // S3
  const [s3Region, setS3Region] = useState('us-east-1');
  const [s3AccessKey, setS3AccessKey] = useState('');
  const [s3SecretKey, setS3SecretKey] = useState('');
  const [s3Bucket, setS3Bucket] = useState('');

  // Google Drive
  const [gdriveEmail, setGdriveEmail] = useState('');
  const [gdriveKey, setGdriveKey] = useState('');
  const [gdriveFolderId, setGdriveFolderId] = useState('');

  // GitHub Target
  const [ghOwner, setGhOwner] = useState('');
  const [ghRepo, setGhRepo] = useState('');
  const [ghBranch, setGhBranch] = useState('main');
  const [ghPat, setGhPat] = useState('');

  // Azure
  const [azureConn, setAzureConn] = useState('');
  const [azureContainer, setAzureContainer] = useState('');

  // Run state
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  function addLog(msg: string) {
    setLogs((prev) => {
      setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 0);
      return [...prev, msg];
    });
  }

  function buildAdapterConfig(): AdapterConfig {
    const cfg: AdapterConfig = {};
    if (r2On && r2AccountId && r2AccessKey && r2SecretKey && r2Bucket) {
      cfg.r2 = { accountId: r2AccountId, accessKeyId: r2AccessKey, secretAccessKey: r2SecretKey, bucket: r2Bucket };
    }
    if (s3On && s3AccessKey && s3SecretKey && s3Bucket) {
      cfg.s3 = { region: s3Region, accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey, bucket: s3Bucket };
    }
    if (gdriveOn && gdriveEmail && gdriveKey && gdriveFolderId) {
      cfg.gdrive = { clientEmail: gdriveEmail, privateKey: gdriveKey, rootFolderId: gdriveFolderId };
    }
    if (ghOn && ghOwner && ghRepo) {
      cfg.githubTarget = { owner: ghOwner, repo: ghRepo, branch: ghBranch || 'main', pat: ghPat || pat };
    }
    if (azureOn && azureConn && azureContainer) {
      cfg.azure = { connectionString: azureConn, container: azureContainer };
    }
    return cfg;
  }

  function countEnabledAdapters() {
    return [r2On, s3On, gdriveOn, ghOn, azureOn].filter(Boolean).length;
  }

  async function startExtraction() {
    if (!pat || !targetName) return;
    setRunning(true);
    setLogs([]);
    setSummary(null);

    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pat,
          targetType,
          targetName,
          adapters: buildAdapterConfig(),
          options: {
            skipForks,
            skipArchived,
            dryRun,
            matchRegex: matchRegex || undefined,
            maxFileSizeKb: maxFileSizeKb ? parseInt(maxFileSizeKb) : undefined,
          },
        }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event.msg) addLog(event.msg);
            if (event.error) addLog(`ERROR: ${event.error}`);
            if (event.done && event.summary) setSummary(event.summary);
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e) {
      addLog(`Connection error: ${e}`);
    }

    setRunning(false);
  }

  const canRun = pat && targetName && (dryRun || countEnabledAdapters() > 0);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur px-6 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-zinc-900 dark:bg-white flex items-center justify-center">
              <span className="text-white dark:text-zinc-900 text-xs font-bold">G</span>
            </div>
            <div>
              <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Detiq GCE</span>
              <span className="text-xs text-zinc-400 ml-2">GitHub Codebase Extractor</span>
            </div>
          </div>
          <a
            href="https://github.com/deepanimators/Detiq-GCE"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            GitHub ↗
          </a>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 grid grid-cols-1 xl:grid-cols-[480px_1fr] gap-6">

        {/* ── Left column: config ─────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Source */}
          <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">GitHub Source</h2>

            <Field
              label="Personal Access Token (PAT)"
              value={pat}
              onChange={setPat}
              placeholder="ghp_..."
              type="password"
            />

            <div className="flex gap-2">
              <div className="w-36">
                <label className="block text-xs text-zinc-500 mb-1">Type</label>
                <select
                  value={targetType}
                  onChange={(e) => setTargetType(e.target.value as 'user' | 'org')}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                >
                  <option value="org">Organization</option>
                  <option value="user">User</option>
                </select>
              </div>
              <div className="flex-1">
                <Field
                  label="Name"
                  value={targetName}
                  onChange={setTargetName}
                  placeholder="myorg or username"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Repo filter (regex, optional)"
                value={matchRegex}
                onChange={setMatchRegex}
                placeholder="e.g. backend.*"
              />
              <Field
                label="Max file size (KB, optional)"
                value={maxFileSizeKb}
                onChange={setMaxFileSizeKb}
                placeholder="e.g. 1024"
              />
            </div>

            <div className="flex flex-wrap gap-4 pt-1">
              {[
                { label: 'Skip forks', val: skipForks, set: setSkipForks },
                { label: 'Skip archived', val: skipArchived, set: setSkipArchived },
                { label: 'Dry run', val: dryRun, set: setDryRun },
              ].map(({ label, val, set }) => (
                <label key={label} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={val}
                    onChange={(e) => set(e.target.checked)}
                    className="rounded border-zinc-300"
                  />
                  {label}
                </label>
              ))}
            </div>
          </section>

          {/* Storage targets */}
          <section className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Storage Targets</h2>
              {countEnabledAdapters() > 0 && (
                <span className="text-xs text-emerald-600 font-medium">{countEnabledAdapters()} active — uploads run in parallel</span>
              )}
            </div>

            {/* R2 */}
            <AdapterToggle id="r2" label="Cloudflare R2" logo="🟠" enabled={r2On} onToggle={() => setR2On(!r2On)}>
              <Field label="Account ID" value={r2AccountId} onChange={setR2AccountId} placeholder="abc123def456" mono />
              <Field label="Access Key ID" value={r2AccessKey} onChange={setR2AccessKey} placeholder="R2 access key ID" type="password" />
              <Field label="Secret Access Key" value={r2SecretKey} onChange={setR2SecretKey} placeholder="R2 secret access key" type="password" />
              <Field label="Bucket Name" value={r2Bucket} onChange={setR2Bucket} placeholder="my-github-backup" />
            </AdapterToggle>

            {/* S3 */}
            <AdapterToggle id="s3" label="AWS S3" logo="🟡" enabled={s3On} onToggle={() => setS3On(!s3On)}>
              <Field label="Region" value={s3Region} onChange={setS3Region} placeholder="us-east-1" />
              <Field label="Access Key ID" value={s3AccessKey} onChange={setS3AccessKey} placeholder="AKIAIOSFODNN7EXAMPLE" type="password" />
              <Field label="Secret Access Key" value={s3SecretKey} onChange={setS3SecretKey} placeholder="secret access key" type="password" />
              <Field label="Bucket Name" value={s3Bucket} onChange={setS3Bucket} placeholder="my-github-backup" />
            </AdapterToggle>

            {/* Google Drive */}
            <AdapterToggle id="gdrive" label="Google Drive" logo="🔵" enabled={gdriveOn} onToggle={() => setGdriveOn(!gdriveOn)}>
              <Field
                label="Service Account Email"
                value={gdriveEmail}
                onChange={setGdriveEmail}
                placeholder="backup@myproject.iam.gserviceaccount.com"
              />
              <Textarea
                label="Private Key (paste full key including BEGIN/END lines)"
                value={gdriveKey}
                onChange={setGdriveKey}
                placeholder={"-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----"}
                rows={5}
              />
              <Field
                label="Root Folder ID"
                value={gdriveFolderId}
                onChange={setGdriveFolderId}
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUq..."
                mono
              />
              <p className="text-xs text-zinc-400">
                Get folder ID from Drive URL: …/folders/<strong>THIS_PART</strong>. Share the folder with the service account email.
              </p>
            </AdapterToggle>

            {/* GitHub Target */}
            <AdapterToggle id="github" label="GitHub Repo" logo="⚫" enabled={ghOn} onToggle={() => setGhOn(!ghOn)}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Owner (user or org)" value={ghOwner} onChange={setGhOwner} placeholder="myorg" />
                <Field label="Repo name" value={ghRepo} onChange={setGhRepo} placeholder="github-backup-store" />
              </div>
              <Field label="Branch" value={ghBranch} onChange={setGhBranch} placeholder="main" />
              <Field
                label="PAT for target repo (leave blank to use source PAT)"
                value={ghPat}
                onChange={setGhPat}
                placeholder="ghp_... (optional)"
                type="password"
              />
              <p className="text-xs text-zinc-400">Target repo must already exist. PAT needs write access to it. Best for small repos (&lt;200 files).</p>
            </AdapterToggle>

            {/* Azure */}
            <AdapterToggle id="azure" label="Azure Blob Storage" logo="🔷" enabled={azureOn} onToggle={() => setAzureOn(!azureOn)}>
              <Textarea
                label="Connection String"
                value={azureConn}
                onChange={setAzureConn}
                placeholder="DefaultEndpointsProtocol=https;AccountName=xxx;AccountKey=xxx;EndpointSuffix=core.windows.net"
                rows={3}
              />
              <Field label="Container Name" value={azureContainer} onChange={setAzureContainer} placeholder="github-backup" />
              <p className="text-xs text-zinc-400">Container is created automatically if it doesn&apos;t exist.</p>
            </AdapterToggle>
          </section>

          {!canRun && !running && (
            <p className="text-xs text-amber-600 dark:text-amber-400 px-1">
              {!pat ? '→ Enter a GitHub PAT' : !targetName ? '→ Enter an org or username' : '→ Enable at least one storage target (or check Dry run)'}
            </p>
          )}

          <Button onClick={startExtraction} disabled={running || !canRun} className="w-full h-10">
            {running ? 'Extracting...' : `Start Extraction${countEnabledAdapters() > 1 ? ` → ${countEnabledAdapters()} targets` : ''}`}
          </Button>
        </div>

        {/* ── Right column: logs ──────────────────────────────────────────── */}
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 flex flex-col sticky top-20" style={{ height: 'calc(100vh - 7rem)' }}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Live Log</h2>
            <div className="flex items-center gap-3">
              {running && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Running
                </span>
              )}
              {!running && logs.length > 0 && (
                <button onClick={() => { setLogs([]); setSummary(null); }} className="text-xs text-zinc-400 hover:text-zinc-600">
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 font-mono text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 min-h-0">
            {logs.length === 0 && !running && (
              <p className="text-zinc-400 text-center mt-20 text-sm font-sans">
                Configure source + storage, then click Start.
              </p>
            )}
            {logs.map((log, i) => (
              <div
                key={i}
                className={
                  log.startsWith('ERROR') ? 'text-red-500' :
                  log.startsWith('[done]') ? 'text-emerald-600 dark:text-emerald-400' :
                  log.startsWith('[start]') ? 'text-blue-600 dark:text-blue-400 font-semibold' :
                  log.startsWith('===') ? 'text-zinc-900 dark:text-zinc-50 font-bold mt-3' :
                  log.startsWith('[warn]') ? 'text-amber-500' :
                  ''
                }
              >
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>

          {summary && (
            <div className="border-t border-zinc-100 dark:border-zinc-800 p-4 flex-shrink-0">
              <div className="grid grid-cols-3 gap-3 mb-3">
                {[
                  { label: 'Repos', value: `${summary.successRepos}/${summary.totalRepos}`, ok: summary.successRepos === summary.totalRepos },
                  { label: 'Uploaded', value: summary.uploadedFiles, ok: true },
                  { label: 'Failed', value: summary.failedFiles, ok: summary.failedFiles === 0 },
                ].map((s) => (
                  <div key={s.label} className="text-center bg-zinc-50 dark:bg-zinc-800 rounded-lg py-2">
                    <div className={`text-xl font-semibold ${s.ok ? 'text-zinc-900 dark:text-zinc-50' : 'text-red-500'}`}>{s.value}</div>
                    <div className="text-xs text-zinc-500">{s.label}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-zinc-400 text-center">
                {summary.skippedFiles > 0 ? `${summary.skippedFiles} files skipped · ` : ''}{summary.totalFiles} total files
              </p>
            </div>
          )}
        </div>
      </main>

      <footer className="max-w-6xl mx-auto px-6 py-4 text-xs text-zinc-400 border-t border-zinc-100 dark:border-zinc-800 mt-2">
        <p>
          Scheduled extraction via{' '}
          <a href="https://cronjobs.org" className="underline hover:text-zinc-600">cronjobs.org</a>
          {' '}→ POST to <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">/api/cron</code>
          {' '}with header <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">x-cron-secret: YOUR_SECRET</code>
          {' '}(set <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">CRON_*</code> env vars in Vercel for scheduled config)
        </p>
      </footer>
    </div>
  );
}
