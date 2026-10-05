'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';

type AdapterConfig = {
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  s3?: { region: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  gdrive?: { clientEmail: string; privateKey: string; rootFolderId: string };
  githubTarget?: { owner: string; repo: string; branch?: string; pat: string };
  azure?: { connectionString: string; container: string };
};

type Summary = {
  totalRepos: number;
  successRepos: number;
  totalFiles: number;
  uploadedFiles: number;
  skippedFiles: number;
  failedFiles: number;
};

export default function Home() {
  const [pat, setPat] = useState('');
  const [targetType, setTargetType] = useState<'user' | 'org'>('org');
  const [targetName, setTargetName] = useState('');
  const [skipForks, setSkipForks] = useState(false);
  const [skipArchived, setSkipArchived] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [matchRegex, setMatchRegex] = useState('');
  const [maxFileSizeKb, setMaxFileSizeKb] = useState('');
  const [adapter, setAdapter] = useState<'r2' | 's3' | 'gdrive' | 'github' | 'azure' | 'none'>('none');

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

  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  function addLog(msg: string) {
    setLogs((prev) => {
      const next = [...prev, msg];
      setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 0);
      return next;
    });
  }

  function buildAdapterConfig(): AdapterConfig {
    if (adapter === 'r2' && r2AccountId && r2AccessKey && r2SecretKey && r2Bucket) {
      return { r2: { accountId: r2AccountId, accessKeyId: r2AccessKey, secretAccessKey: r2SecretKey, bucket: r2Bucket } };
    }
    if (adapter === 's3' && s3AccessKey && s3SecretKey && s3Bucket) {
      return { s3: { region: s3Region, accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey, bucket: s3Bucket } };
    }
    return {};
  }

  async function startExtraction() {
    if (!pat || !targetName) return;
    setRunning(true);
    setLogs([]);
    setSummary(null);

    const adapterConfig = buildAdapterConfig();

    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pat,
          targetType,
          targetName,
          adapters: adapterConfig,
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
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (e) {
      addLog(`Connection error: ${e}`);
    }

    setRunning(false);
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-zinc-900 dark:bg-white flex items-center justify-center">
            <span className="text-white dark:text-zinc-900 text-sm font-bold">G</span>
          </div>
          <div>
            <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Detiq GCE</h1>
            <p className="text-xs text-zinc-500">GitHub Codebase Extractor</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Config panel */}
        <div className="space-y-5">
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Source</h2>

            <div>
              <label className="text-xs text-zinc-500 mb-1 block">GitHub PAT</label>
              <input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="ghp_..."
                className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
              />
            </div>

            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-zinc-500 mb-1 block">Type</label>
                <select
                  value={targetType}
                  onChange={(e) => setTargetType(e.target.value as 'user' | 'org')}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                >
                  <option value="org">Organization</option>
                  <option value="user">User</option>
                </select>
              </div>
              <div className="flex-[2]">
                <label className="text-xs text-zinc-500 mb-1 block">Name</label>
                <input
                  type="text"
                  value={targetName}
                  onChange={(e) => setTargetName(e.target.value)}
                  placeholder="my-org or username"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Repo name filter (regex, optional)</label>
              <input
                type="text"
                value={matchRegex}
                onChange={(e) => setMatchRegex(e.target.value)}
                placeholder="e.g. backend.*"
                className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
            </div>

            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Max file size (KB, optional)</label>
              <input
                type="number"
                value={maxFileSizeKb}
                onChange={(e) => setMaxFileSizeKb(e.target.value)}
                placeholder="e.g. 1024"
                className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
            </div>

            <div className="flex gap-4 pt-1">
              <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={skipForks} onChange={(e) => setSkipForks(e.target.checked)} className="rounded" />
                Skip forks
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={skipArchived} onChange={(e) => setSkipArchived(e.target.checked)} className="rounded" />
                Skip archived
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="rounded" />
                Dry run
              </label>
            </div>
          </div>

          {/* Storage adapter */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Storage Target</h2>

            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Adapter</label>
              <select
                value={adapter}
                onChange={(e) => setAdapter(e.target.value as typeof adapter)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              >
                <option value="none">None (dry run only)</option>
                <option value="r2">Cloudflare R2</option>
                <option value="s3">AWS S3</option>
                <option value="gdrive">Google Drive</option>
                <option value="github">GitHub Repo</option>
                <option value="azure">Azure Blob</option>
              </select>
            </div>

            {adapter === 'r2' && (
              <div className="space-y-2">
                {[
                  ['Account ID', r2AccountId, setR2AccountId, 'abc123...'],
                  ['Access Key ID', r2AccessKey, setR2AccessKey, 'R2 access key'],
                  ['Secret Access Key', r2SecretKey, setR2SecretKey, 'R2 secret'],
                  ['Bucket', r2Bucket, setR2Bucket, 'my-bucket'],
                ].map(([label, val, setter, ph]) => (
                  <div key={label as string}>
                    <label className="text-xs text-zinc-500 mb-1 block">{label as string}</label>
                    <input
                      type={String(label).includes('Secret') || String(label).includes('Key') ? 'password' : 'text'}
                      value={val as string}
                      onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                      placeholder={ph as string}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                    />
                  </div>
                ))}
              </div>
            )}

            {adapter === 's3' && (
              <div className="space-y-2">
                {[
                  ['Region', s3Region, setS3Region, 'us-east-1'],
                  ['Access Key ID', s3AccessKey, setS3AccessKey, 'AKIA...'],
                  ['Secret Access Key', s3SecretKey, setS3SecretKey, 'secret'],
                  ['Bucket', s3Bucket, setS3Bucket, 'my-bucket'],
                ].map(([label, val, setter, ph]) => (
                  <div key={label as string}>
                    <label className="text-xs text-zinc-500 mb-1 block">{label as string}</label>
                    <input
                      type={String(label).includes('Secret') || String(label).includes('Key') ? 'password' : 'text'}
                      value={val as string}
                      onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                      placeholder={ph as string}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                    />
                  </div>
                ))}
              </div>
            )}

            {(adapter === 'gdrive' || adapter === 'github' || adapter === 'azure') && (
              <p className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-800 rounded-lg p-3">
                Configure {adapter === 'gdrive' ? 'Google Drive' : adapter === 'github' ? 'GitHub target' : 'Azure'} via environment variables in Vercel dashboard, then use the scheduled cron endpoint.
                <br /><br />
                For one-off extractions, use the CLI tool instead.
              </p>
            )}
          </div>

          <Button
            onClick={startExtraction}
            disabled={running || !pat || !targetName}
            className="w-full h-10"
          >
            {running ? 'Extracting...' : 'Start Extraction'}
          </Button>
        </div>

        {/* Log panel */}
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 flex flex-col" style={{ minHeight: 480 }}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Log</h2>
            {running && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Running
              </span>
            )}
            {!running && logs.length > 0 && (
              <button
                onClick={() => { setLogs([]); setSummary(null); }}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4 font-mono text-xs text-zinc-700 dark:text-zinc-300 space-y-0.5">
            {logs.length === 0 && !running && (
              <p className="text-zinc-400 text-center mt-16">Logs will appear here during extraction</p>
            )}
            {logs.map((log, i) => (
              <div
                key={i}
                className={
                  log.startsWith('ERROR') ? 'text-red-500' :
                  log.startsWith('[done]') ? 'text-emerald-600 dark:text-emerald-400' :
                  log.startsWith('[start]') ? 'text-blue-600 dark:text-blue-400 font-medium' :
                  log.startsWith('===') ? 'text-zinc-900 dark:text-zinc-50 font-semibold mt-2' :
                  ''
                }
              >
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>

          {summary && (
            <div className="border-t border-zinc-100 dark:border-zinc-800 p-4 grid grid-cols-3 gap-3">
              {[
                { label: 'Repos', value: `${summary.successRepos}/${summary.totalRepos}` },
                { label: 'Uploaded', value: summary.uploadedFiles },
                { label: 'Failed', value: summary.failedFiles },
              ].map((s) => (
                <div key={s.label} className="text-center">
                  <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{s.value}</div>
                  <div className="text-xs text-zinc-500">{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      <footer className="text-center text-xs text-zinc-400 py-6">
        <p>
          Cron endpoint: <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">/api/cron</code>
          {' · '}
          <a href="https://github.com/deepanimators/Detiq-GCE" className="underline hover:text-zinc-600">GitHub</a>
        </p>
        <p className="mt-1">Schedule at <a href="https://cronjobs.org" className="underline hover:text-zinc-600">cronjobs.org</a> → POST to /api/cron with header <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">x-cron-secret: YOUR_SECRET</code></p>
      </footer>
    </div>
  );
}
