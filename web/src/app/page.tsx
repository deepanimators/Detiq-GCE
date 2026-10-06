'use client';

import { useEffect, useState, useRef } from 'react';
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

const METADATA_TYPES = [
  { id: 'issues', label: 'Issues' },
  { id: 'issue-comments', label: 'Issue comments' },
  { id: 'prs', label: 'Pull requests' },
  { id: 'pr-reviews', label: 'PR reviews' },
  { id: 'pr-comments', label: 'PR comments' },
  { id: 'releases', label: 'Releases' },
  { id: 'release-assets', label: 'Release assets' },
  { id: 'labels', label: 'Labels' },
  { id: 'milestones', label: 'Milestones' },
];

const FORM_STORAGE_KEY = 'detiq-gce-form-v1';

// ── Shared UI components ──────────────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, type = 'text', mono = false, hint,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; mono?: boolean; hint?: string;
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
      {hint && <p className="text-xs text-zinc-400 mt-1">{hint}</p>}
    </div>
  );
}

function Textarea({
  label, value, onChange, placeholder, rows = 4, hint,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; rows?: number; hint?: string;
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
      {hint && <p className="text-xs text-zinc-400 mt-1">{hint}</p>}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="rounded border-zinc-300" />
      {label}
    </label>
  );
}

function AdapterToggle({
  label, logo, enabled, onToggle, children,
}: {
  label: string; logo: string; enabled: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border transition-colors ${enabled ? 'border-zinc-900 dark:border-zinc-100 bg-white dark:bg-zinc-900' : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50'}`}>
      <button type="button" onClick={onToggle} className="w-full flex items-center justify-between px-4 py-3 text-left">
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-4">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
      {children}
    </section>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function Home() {
  // Source
  const [pat, setPat] = useState('');
  const [targetType, setTargetType] = useState<'user' | 'org'>('org');
  const [targetName, setTargetName] = useState('');
  const [visibility, setVisibility] = useState<'all' | 'public' | 'private'>('all');

  // Filters
  const [skipForks, setSkipForks] = useState(false);
  const [skipArchived, setSkipArchived] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [matchRegex, setMatchRegex] = useState('');
  const [topics, setTopics] = useState('');

  // Files
  const [maxFileSizeKb, setMaxFileSizeKb] = useState('');
  const [useDefaultExcludes, setUseDefaultExcludes] = useState(true);
  const [extraExcludes, setExtraExcludes] = useState('');

  // Concurrency
  const [repoConcurrency, setRepoConcurrency] = useState('');
  const [fileConcurrency, setFileConcurrency] = useState('');

  // Metadata
  const [metadataEnabled, setMetadataEnabled] = useState(false);
  const [metadataTypes, setMetadataTypes] = useState<Set<string>>(new Set(METADATA_TYPES.map((t) => t.id)));

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
  const [formHydrated, setFormHydrated] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(FORM_STORAGE_KEY);
      if (saved) {
        const state = JSON.parse(saved) as Record<string, unknown>;
        const setString = (key: string, setter: (value: string) => void) => {
          if (typeof state[key] === 'string') setter(state[key] as string);
        };
        const setBoolean = (key: string, setter: (value: boolean) => void) => {
          if (typeof state[key] === 'boolean') setter(state[key] as boolean);
        };

        setString('pat', setPat);
        setString('targetName', setTargetName);
        setString('matchRegex', setMatchRegex);
        setString('topics', setTopics);
        setString('maxFileSizeKb', setMaxFileSizeKb);
        setString('extraExcludes', setExtraExcludes);
        setString('repoConcurrency', setRepoConcurrency);
        setString('fileConcurrency', setFileConcurrency);
        setString('r2AccountId', setR2AccountId);
        setString('r2AccessKey', setR2AccessKey);
        setString('r2SecretKey', setR2SecretKey);
        setString('r2Bucket', setR2Bucket);
        setString('s3Region', setS3Region);
        setString('s3AccessKey', setS3AccessKey);
        setString('s3SecretKey', setS3SecretKey);
        setString('s3Bucket', setS3Bucket);
        setString('gdriveEmail', setGdriveEmail);
        setString('gdriveKey', setGdriveKey);
        setString('gdriveFolderId', setGdriveFolderId);
        setString('ghOwner', setGhOwner);
        setString('ghRepo', setGhRepo);
        setString('ghBranch', setGhBranch);
        setString('ghPat', setGhPat);
        setString('azureConn', setAzureConn);
        setString('azureContainer', setAzureContainer);
        setString('targetType', (value) => {
          if (value === 'user' || value === 'org') setTargetType(value);
        });
        setString('visibility', (value) => {
          if (value === 'all' || value === 'public' || value === 'private') setVisibility(value);
        });
        setBoolean('skipForks', setSkipForks);
        setBoolean('skipArchived', setSkipArchived);
        setBoolean('dryRun', setDryRun);
        setBoolean('useDefaultExcludes', setUseDefaultExcludes);
        setBoolean('metadataEnabled', setMetadataEnabled);
        setBoolean('r2On', setR2On);
        setBoolean('s3On', setS3On);
        setBoolean('gdriveOn', setGdriveOn);
        setBoolean('ghOn', setGhOn);
        setBoolean('azureOn', setAzureOn);
        if (Array.isArray(state.metadataTypes)) {
          const metadataTypeValues = state.metadataTypes.filter((v): v is string => typeof v === 'string');
          queueMicrotask(() => {
            setMetadataTypes(new Set(metadataTypeValues));
          });
        }
      }
    } catch {
      localStorage.removeItem(FORM_STORAGE_KEY);
    } finally {
      setFormHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!formHydrated) return;
    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify({
      pat, targetType, targetName, visibility, skipForks, skipArchived, dryRun,
      matchRegex, topics, maxFileSizeKb, useDefaultExcludes, extraExcludes,
      repoConcurrency, fileConcurrency, metadataEnabled, metadataTypes: [...metadataTypes],
      r2On, s3On, gdriveOn, ghOn, azureOn, r2AccountId, r2AccessKey, r2SecretKey,
      r2Bucket, s3Region, s3AccessKey, s3SecretKey, s3Bucket, gdriveEmail, gdriveKey,
      gdriveFolderId, ghOwner, ghRepo, ghBranch, ghPat, azureConn, azureContainer,
    }));
  }, [
    formHydrated, pat, targetType, targetName, visibility, skipForks, skipArchived, dryRun,
    matchRegex, topics, maxFileSizeKb, useDefaultExcludes, extraExcludes,
    repoConcurrency, fileConcurrency, metadataEnabled, metadataTypes, r2On, s3On,
    gdriveOn, ghOn, azureOn, r2AccountId, r2AccessKey, r2SecretKey, r2Bucket,
    s3Region, s3AccessKey, s3SecretKey, s3Bucket, gdriveEmail, gdriveKey,
    gdriveFolderId, ghOwner, ghRepo, ghBranch, ghPat, azureConn, azureContainer,
  ]);

  function addLog(msg: string) {
    setLogs((prev) => {
      setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 0);
      return [...prev, msg];
    });
  }

  function countAdapters() {
    return [r2On, s3On, gdriveOn, ghOn, azureOn].filter(Boolean).length;
  }

  function buildAdapterConfig(): AdapterConfig {
    const cfg: AdapterConfig = {};
    if (r2On && r2AccountId && r2AccessKey && r2SecretKey && r2Bucket)
      cfg.r2 = { accountId: r2AccountId, accessKeyId: r2AccessKey, secretAccessKey: r2SecretKey, bucket: r2Bucket };
    if (s3On && s3AccessKey && s3SecretKey && s3Bucket)
      cfg.s3 = { region: s3Region, accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey, bucket: s3Bucket };
    if (gdriveOn && gdriveEmail && gdriveKey && gdriveFolderId)
      cfg.gdrive = { clientEmail: gdriveEmail, privateKey: gdriveKey, rootFolderId: gdriveFolderId };
    if (ghOn && ghOwner && ghRepo)
      cfg.githubTarget = { owner: ghOwner, repo: ghRepo, branch: ghBranch || 'main', pat: ghPat || pat };
    if (azureOn && azureConn && azureContainer)
      cfg.azure = { connectionString: azureConn, container: azureContainer };
    return cfg;
  }

  function toggleMetadataType(id: string) {
    setMetadataTypes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
            visibility,
            matchRegex: matchRegex || undefined,
            topics: topics ? topics.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
            maxFileSizeKb: maxFileSizeKb ? parseInt(maxFileSizeKb) : undefined,
            useDefaultExcludes,
            extraExcludes: extraExcludes ? extraExcludes.split(',').map((p) => p.trim()).filter(Boolean) : undefined,
            repoConcurrency: repoConcurrency ? parseInt(repoConcurrency) : undefined,
            fileConcurrency: fileConcurrency ? parseInt(fileConcurrency) : undefined,
            metadata: metadataEnabled || undefined,
            metadataTypes: metadataEnabled && metadataTypes.size < METADATA_TYPES.length
              ? [...metadataTypes].join(',')
              : undefined,
          },
        }),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(errorBody || `Request failed with HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('The server returned no live log stream');

      const reader = res.body.getReader();
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
          } catch (e) {
            addLog(`[parse error] ${e}`);
          }
        }
      }
      buffer += decoder.decode();
      const finalLine = buffer.replace(/^data: /, '').trim();
      if (finalLine) {
        const event = JSON.parse(finalLine);
        if (event.msg) addLog(event.msg);
        if (event.error) addLog(`ERROR: ${event.error}`);
        if (event.done && event.summary) setSummary(event.summary);
      }
    } catch (e) {
      addLog(`Connection error: ${e}`);
    } finally {
      setRunning(false);
    }
  }

  const canRun = pat && targetName && (dryRun || countAdapters() > 0);

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
          <a href="https://github.com/deepanimators/Detiq-GCE" target="_blank" rel="noopener noreferrer"
            className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            GitHub ↗
          </a>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 grid grid-cols-1 xl:grid-cols-[minmax(0,500px)_minmax(0,1fr)] gap-6 items-start">

        {/* ── Left: config ──────────────────────────────────────────────── */}
        <div className="space-y-4 min-w-0">

          {/* Source */}
          <Section title="GitHub Source">
            <Field label="Personal Access Token (PAT)" value={pat} onChange={setPat}
              placeholder="ghp_..." type="password"
              hint="Needs 'repo' scope to read private repos" />

            <div className="flex gap-2">
              <div className="w-36">
                <label className="block text-xs text-zinc-500 mb-1">Type</label>
                <select value={targetType} onChange={(e) => setTargetType(e.target.value as 'user' | 'org')}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900">
                  <option value="org">Organization</option>
                  <option value="user">User</option>
                </select>
              </div>
              <div className="flex-1">
                <Field label="Name" value={targetName} onChange={setTargetName} placeholder="myorg or username" />
              </div>
              <div className="w-28">
                <label className="block text-xs text-zinc-500 mb-1">Visibility</label>
                <select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900">
                  <option value="all">All</option>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Repo name filter (regex)" value={matchRegex} onChange={setMatchRegex} placeholder="e.g. backend.*" />
              <Field label="Topics filter (comma-sep, AND)" value={topics} onChange={setTopics} placeholder="e.g. typescript,api" />
            </div>

            <div className="flex flex-wrap gap-4">
              <Check label="Skip forks" checked={skipForks} onChange={setSkipForks} />
              <Check label="Skip archived" checked={skipArchived} onChange={setSkipArchived} />
              <Check label="Dry run" checked={dryRun} onChange={setDryRun} />
            </div>
          </Section>

          {/* Files */}
          <Section title="File Options">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max file size (KB)" value={maxFileSizeKb} onChange={setMaxFileSizeKb} placeholder="e.g. 1024"
                hint="Skips files above this size" />
              <div className="space-y-1">
                <label className="block text-xs text-zinc-500">Default excludes</label>
                <Check label="Apply (node_modules, dist, *.lock…)" checked={useDefaultExcludes} onChange={setUseDefaultExcludes} />
              </div>
            </div>
            <Textarea label="Extra exclude patterns (comma-separated)" value={extraExcludes} onChange={setExtraExcludes}
              placeholder="*.log, temp/, **/__tests__/" rows={2}
              hint="Supports: *.ext  prefix/  **/pattern" />
          </Section>

          {/* Metadata */}
          <Section title="Metadata Backup">
            <Check label="Enable metadata backup (issues, PRs, releases…)" checked={metadataEnabled} onChange={setMetadataEnabled} />
            {metadataEnabled && (
              <>
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Issue comments + PR reviews consume many API calls on large repos.
                </p>
                <div className="grid grid-cols-3 gap-x-4 gap-y-2">
                  {METADATA_TYPES.map((t) => (
                    <Check key={t.id} label={t.label} checked={metadataTypes.has(t.id)} onChange={() => toggleMetadataType(t.id)} />
                  ))}
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setMetadataTypes(new Set(METADATA_TYPES.map((t) => t.id)))}
                    className="text-xs text-zinc-500 hover:text-zinc-800">Select all</button>
                  <span className="text-xs text-zinc-300">·</span>
                  <button onClick={() => setMetadataTypes(new Set())}
                    className="text-xs text-zinc-500 hover:text-zinc-800">Clear all</button>
                </div>
              </>
            )}
          </Section>

          {/* Concurrency */}
          <Section title="Performance">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Repo concurrency" value={repoConcurrency} onChange={setRepoConcurrency}
                placeholder="3 (default)" hint="Parallel repos at a time" />
              <Field label="File concurrency" value={fileConcurrency} onChange={setFileConcurrency}
                placeholder="10 (default)" hint="Parallel files per repo" />
            </div>
          </Section>

          {/* Storage */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Storage Targets</h2>
              {countAdapters() > 0 && (
                <span className="text-xs text-emerald-600 font-medium">{countAdapters()} active · parallel upload</span>
              )}
            </div>

            <AdapterToggle label="Cloudflare R2" logo="🟠" enabled={r2On} onToggle={() => setR2On(!r2On)}>
              <Field label="Account ID" value={r2AccountId} onChange={setR2AccountId} placeholder="abc123def456" mono />
              <Field label="Access Key ID" value={r2AccessKey} onChange={setR2AccessKey} type="password" placeholder="R2 access key ID" />
              <Field label="Secret Access Key" value={r2SecretKey} onChange={setR2SecretKey} type="password" placeholder="R2 secret access key" />
              <Field label="Bucket Name" value={r2Bucket} onChange={setR2Bucket} placeholder="my-github-backup" />
            </AdapterToggle>

            <AdapterToggle label="AWS S3" logo="🟡" enabled={s3On} onToggle={() => setS3On(!s3On)}>
              <Field label="Region" value={s3Region} onChange={setS3Region} placeholder="us-east-1" />
              <Field label="Access Key ID" value={s3AccessKey} onChange={setS3AccessKey} type="password" placeholder="AKIA..." />
              <Field label="Secret Access Key" value={s3SecretKey} onChange={setS3SecretKey} type="password" placeholder="secret" />
              <Field label="Bucket Name" value={s3Bucket} onChange={setS3Bucket} placeholder="my-github-backup" />
            </AdapterToggle>

            <AdapterToggle label="Google Drive" logo="🔵" enabled={gdriveOn} onToggle={() => setGdriveOn(!gdriveOn)}>
              <Field label="Service Account Email" value={gdriveEmail} onChange={setGdriveEmail}
                placeholder="backup@myproject.iam.gserviceaccount.com" />
              <Textarea label="Private Key (full key with BEGIN/END lines)" value={gdriveKey} onChange={setGdriveKey}
                placeholder={"-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----"} rows={5} />
              <Field label="Root Folder ID" value={gdriveFolderId} onChange={setGdriveFolderId}
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUq..." mono
                hint="From Drive URL: .../folders/THIS_PART — share folder with service account email" />
            </AdapterToggle>

            <AdapterToggle label="GitHub Repo" logo="⚫" enabled={ghOn} onToggle={() => setGhOn(!ghOn)}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Owner (user or org)" value={ghOwner} onChange={setGhOwner} placeholder="myorg" />
                <Field label="Repo name" value={ghRepo} onChange={setGhRepo} placeholder="github-backup-store" />
              </div>
              <Field label="Branch" value={ghBranch} onChange={setGhBranch} placeholder="main" />
              <Field label="PAT for target repo (blank = use source PAT)" value={ghPat} onChange={setGhPat}
                type="password" placeholder="ghp_... (optional)"
                hint="Target repo must exist. Best for small repos (<200 files)." />
            </AdapterToggle>

            <AdapterToggle label="Azure Blob Storage" logo="🔷" enabled={azureOn} onToggle={() => setAzureOn(!azureOn)}>
              <Textarea label="Connection String" value={azureConn} onChange={setAzureConn}
                placeholder="DefaultEndpointsProtocol=https;AccountName=xxx;AccountKey=xxx;EndpointSuffix=core.windows.net"
                rows={3} />
              <Field label="Container Name" value={azureContainer} onChange={setAzureContainer} placeholder="github-backup"
                hint="Created automatically if it doesn't exist" />
            </AdapterToggle>
          </div>

          {!canRun && !running && (
            <p className="text-xs text-amber-600 dark:text-amber-400 px-1">
              {!pat ? '→ Enter GitHub PAT' : !targetName ? '→ Enter org or username' : '→ Enable at least one storage target (or check Dry run)'}
            </p>
          )}

          <Button onClick={startExtraction} disabled={running || !canRun} className="w-full h-10">
            {running
              ? 'Extracting...'
              : `Start Extraction${countAdapters() > 1 ? ` → ${countAdapters()} targets` : ''}${metadataEnabled ? ' + metadata' : ''}`}
          </Button>
          <p className="text-[11px] text-zinc-400 px-1">
            Configuration is saved locally in this browser and restored after refresh. Clear this site&apos;s
            storage if you are using a shared device.
          </p>
        </div>

        {/* ── Right: live log ────────────────────────────────────────────── */}
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
                <button onClick={() => { setLogs([]); setSummary(null); }}
                  className="text-xs text-zinc-400 hover:text-zinc-600">Clear</button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 font-mono text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 min-h-0">
            {logs.length === 0 && !running && (
              <p className="text-zinc-400 text-center mt-20 font-sans text-sm">
                Configure source + storage targets, then click Start.
              </p>
            )}
            {logs.map((log, i) => (
              <div key={i} className={
                log.startsWith('ERROR') ? 'text-red-500' :
                log.startsWith('[done]') ? 'text-emerald-600 dark:text-emerald-400' :
                log.startsWith('[start]') ? 'text-blue-600 dark:text-blue-400 font-semibold' :
                log.startsWith('===') ? 'text-zinc-900 dark:text-zinc-50 font-bold mt-3' :
                log.startsWith('[warn]') ? 'text-amber-500' :
                log.startsWith('[error]') ? 'text-red-400' :
                ''
              }>
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>

          {summary && (
            <div className="border-t border-zinc-100 dark:border-zinc-800 p-4 flex-shrink-0">
              <div className="grid grid-cols-3 gap-3 mb-2">
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
              {(summary.skippedFiles > 0 || summary.totalFiles > 0) && (
                <p className="text-xs text-zinc-400 text-center">
                  {summary.totalFiles} total files{summary.skippedFiles > 0 ? ` · ${summary.skippedFiles} skipped` : ''}
                </p>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="max-w-6xl mx-auto px-6 py-4 text-xs text-zinc-400 border-t border-zinc-100 dark:border-zinc-800 mt-2">
        Scheduled runs via{' '}
        <a href="https://cronjobs.org" className="underline hover:text-zinc-600">cronjobs.org</a>
        {' '}→ POST <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">/api/cron</code>
        {' '}with <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">x-cron-secret: YOUR_SECRET</code>
        {' '}· Set <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">CRON_*</code> env vars in Vercel for cron config
      </footer>
    </div>
  );
}
