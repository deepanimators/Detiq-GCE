'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { ClipboardCopy, Download, Eye, EyeOff, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

// ── Types ─────────────────────────────────────────────────────────────────────

type AdapterConfig = {
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  s3?: { region: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  gdrive?: { clientEmail: string; privateKey: string; rootFolderId: string };
  githubTarget?: { owner: string; repo: string; branch: string; pat: string };
  azure?: { connectionString: string; container: string };
};

type RepositoryChoice = {
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  topics: string[];
  branches?: string[];
};

type Summary = {
  totalRepos: number; successRepos: number;
  totalFiles: number; uploadedFiles: number;
  skippedFiles: number; failedFiles: number;
  totalFolders?: number; uploadedFolders?: number;
  skippedExistingFiles?: number; skippedExistingFolders?: number;
};

type RunStatus =
  | 'queued'
  | 'preflight_failed'
  | 'running'
  | 'paused'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

type RunRecord = {
  id: string;
  status: RunStatus;
  estimatedRepos: number;
  discoveredRepos: number;
  completedRepos: number;
  partialRepos: number;
  failedRepos: number;
  bytesUploaded: number;
  errorCode?: string;
  errorMessage?: string;
};

type RunEventEnvelope = {
  event?: { type: string; message?: string; sequence: number; errorCode?: string };
  run?: RunRecord;
  error?: string;
};
type RunEventRecord = NonNullable<RunEventEnvelope['event']>;

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

const LEGACY_FORM_STORAGE_KEY = 'detiq-gce-form-v1';
const CREDENTIAL_STORAGE_KEYS = {
  source: 'detiq-gce-source-v1',
  r2: 'detiq-gce-r2-v1',
  s3: 'detiq-gce-s3-v1',
  gdrive: 'detiq-gce-gdrive-v1',
  githubTarget: 'detiq-gce-github-target-v1',
  azure: 'detiq-gce-azure-v1',
} as const;
const RUN_CACHE_STORAGE_KEY = 'detiq-gce-run-cache-v1';
const MAX_CACHED_RUNS = 10;
const MAX_CACHED_LOG_LINES = 2000;
const REPOSITORY_FETCH_TIMEOUT_MS = 25_000;
const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'preflight_failed',
  'completed',
  'partial',
  'failed',
  'cancelled',
]);

type CredentialSection = keyof typeof CREDENTIAL_STORAGE_KEYS;
type PersistedSectionState = Record<string, unknown>;
type CredentialStatusMap = Partial<Record<CredentialSection, string>>;
type CachedRunSession = {
  run: RunRecord;
  logs: string[];
  summary: Summary | null;
  lastEventSequence?: number;
  updatedAt: string;
};
type RunCacheState = {
  activeRunId?: string;
  runs: Record<string, CachedRunSession>;
};

function isTerminalRunStatus(status: RunStatus) {
  return TERMINAL_RUN_STATUSES.has(status);
}

function isRoutineLogLine(log: string) {
  return log.startsWith('[worker]') ||
    log.startsWith('Live events disconnected') ||
    log.startsWith('[run.created]') ||
    log.startsWith('[run.queued]');
}

function latestStatusLine(logs: string[]) {
  return logs.findLast((log) =>
    log.startsWith('[worker]') ||
    log.startsWith('Live events disconnected') ||
    log.startsWith('[run.started]') ||
    log.startsWith('[run.failed]') ||
    log.startsWith('[run.completed]') ||
    log.startsWith('[run.partial]')
  );
}

// ── Shared UI components ──────────────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, type = 'text', mono = false, hint,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; mono?: boolean; hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  const isSecret = type === 'password';

  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <div className="relative">
        <input
          type={isSecret && !visible ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 ${mono ? 'font-mono' : ''} ${isSecret ? 'pr-10' : ''}`}
        />
        {isSecret && (
          <button
            type="button"
            onClick={() => setVisible((current) => !current)}
            aria-label={visible ? `Hide ${label}` : `Show ${label}`}
            title={visible ? 'Hide secret' : 'Show secret'}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-700 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
          >
            {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        )}
      </div>
      {hint && <p className="text-xs text-zinc-400 mt-1">{hint}</p>}
    </div>
  );
}

function Textarea({
  label, value, onChange, placeholder, rows = 4, hint, secret = false,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; rows?: number; hint?: string; secret?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <div className="relative">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          className={`w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900 font-mono resize-none ${secret ? 'pr-10' : ''} ${secret && !visible ? '[-webkit-text-security:disc]' : ''}`}
        />
        {secret && (
          <button
            type="button"
            onClick={() => setVisible((current) => !current)}
            aria-label={visible ? `Hide ${label}` : `Show ${label}`}
            title={visible ? 'Hide secret' : 'Show secret'}
            className="absolute right-2 top-2 rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-700 dark:hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100"
          >
            {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        )}
      </div>
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

function SectionStorageActions({
  label,
  status,
  disabled,
  onSave,
  onClear,
}: {
  label: string;
  status?: string;
  disabled?: boolean;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-3">
      <p className="text-[11px] text-zinc-400 min-h-4 flex-1">{status || 'Saved only when you choose.'}</p>
      <div className="flex items-center gap-2">
        <Button type="button" size="xs" variant="outline" onClick={onSave} disabled={disabled}>
          <Save data-icon="inline-start" />
          Save {label}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onClear} disabled={disabled} className="text-zinc-500 hover:text-red-600">
          <Trash2 data-icon="inline-start" />
          Clear
        </Button>
      </div>
    </div>
  );
}

function canUseLocalStorage(): boolean {
  try {
    const key = '__detiq_storage_probe__';
    window.localStorage.setItem(key, '1');
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function summarizeActualError(logs: string[], currentRun: RunRecord | null): string | null {
  const candidates = [
    currentRun?.errorMessage,
    ...logs.filter((log) =>
      log.startsWith('ERROR') ||
      log.startsWith('[error]') ||
      log.startsWith('[warn]') ||
      /failed|error|does not exist|forbidden|denied|unauthorized/i.test(log)
    ),
  ].filter((value): value is string => Boolean(value?.trim()));

  if (!candidates.length) return null;

  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const normalized = normalizeLogError(candidate);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  const [message, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return count > 1 ? `${message} Seen ${count} times.` : message;
}

function normalizeLogError(log: string): string {
  const afterDash = log.match(/—\s*(.+)$/)?.[1];
  const afterError = log.match(/^ERROR:\s*(.+)$/)?.[1];
  const afterPreflight = log.match(/^\[preflight failed\]\s*(.+)$/)?.[1];
  return (afterDash ?? afterError ?? afterPreflight ?? log)
    .replace(/\s+/g, ' ')
    .trim();
}

function buildLogExport(args: {
  logs: string[];
  currentRun: RunRecord | null;
  actualError: string | null;
}): string {
  const header = [
    'Detiq GCE run log',
    `Exported at: ${new Date().toISOString()}`,
    args.currentRun ? `Run ID: ${args.currentRun.id}` : null,
    args.currentRun ? `Status: ${args.currentRun.status}` : null,
    args.actualError ? `Actual error: ${args.actualError}` : null,
  ].filter(Boolean);

  return `${header.join('\n')}\n\n${args.logs.join('\n')}\n`;
}

function fallbackCopyText(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

function readStoredSection(storageKey: string): PersistedSectionState | null {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return null;
  const parsed = JSON.parse(saved) as unknown;
  return parsed && typeof parsed === 'object' ? parsed as PersistedSectionState : null;
}

function readRunCache(): RunCacheState {
  const saved = localStorage.getItem(RUN_CACHE_STORAGE_KEY);
  if (!saved) return { runs: {} };
  const parsed = JSON.parse(saved) as Partial<RunCacheState>;
  return parsed && typeof parsed === 'object' && parsed.runs && typeof parsed.runs === 'object'
    ? { activeRunId: parsed.activeRunId, runs: parsed.runs as Record<string, CachedRunSession> }
    : { runs: {} };
}

function writeRunCache(cache: RunCacheState): void {
  const entries = Object.entries(cache.runs)
    .sort(([, a], [, b]) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_CACHED_RUNS);
  localStorage.setItem(RUN_CACHE_STORAGE_KEY, JSON.stringify({
    activeRunId: cache.activeRunId,
    runs: Object.fromEntries(entries),
  } satisfies RunCacheState));
}

function latestCachedRun(cache: RunCacheState): CachedRunSession | null {
  return Object.values(cache.runs)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function Home() {
  // Source
  const [pat, setPat] = useState('');
  const [targetType, setTargetType] = useState<'user' | 'org'>('org');
  const [targetName, setTargetName] = useState('');
  const [visibility, setVisibility] = useState<'all' | 'public' | 'private'>('all');

  // Auth State
  const [auth, setAuth] = useState<{ authenticated: boolean; user?: { login: string; avatar_url: string }; hasToken?: boolean } | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => setAuth(data))
      .catch((err) => console.error('Failed to fetch auth', err));
  }, []);
  const [repositories, setRepositories] = useState<RepositoryChoice[]>([]);
  const [selectedRepositories, setSelectedRepositories] = useState<Set<string>>(new Set());
  const [branchOverrides, setBranchOverrides] = useState<Record<string, string>>({});
  const [repoSearch, setRepoSearch] = useState('');
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [repositoryError, setRepositoryError] = useState('');
  const [loadingBranches, setLoadingBranches] = useState<string | null>(null);
  const [repoListOpen, setRepoListOpen] = useState(false);

  // Filters
  const [captureMode, setCaptureMode] = useState<'mirror' | 'selective-api' | 'metadata-only'>('mirror');
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
  const [currentRun, setCurrentRun] = useState<RunRecord | null>(null);
  const [lastRunEventSequence, setLastRunEventSequence] = useState(0);
  const [formHydrated, setFormHydrated] = useState(false);
  const [runCacheHydrated, setRunCacheHydrated] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [credentialSaveStatus, setCredentialSaveStatus] = useState<CredentialStatusMap>({});
  const [logActionStatus, setLogActionStatus] = useState('');
  const [runCacheStatus, setRunCacheStatus] = useState('');
  const logScrollRef = useRef<HTMLDivElement>(null);
  const activeWatcherRef = useRef<string | null>(null);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => {
      if (isRoutineLogLine(msg) && prev.slice(-8).includes(msg)) return prev;
      setTimeout(() => {
        const scroller = logScrollRef.current;
        scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
      }, 0);
      return [...prev, msg];
    });
  }, []);

  const watchRun = useCallback(async (runId: string, initialEventSequence = 0) => {
    if (activeWatcherRef.current === runId) return;
    activeWatcherRef.current = runId;

    return new Promise<void>((resolve) => {
      const events = new EventSource(`/api/runs/${runId}/events`);
      let settled = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let lastEventSequence = initialEventSequence;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        events.close();
        if (activeWatcherRef.current === runId) activeWatcherRef.current = null;
        resolve();
      };

      const applyRun = (run: RunRecord) => {
        setCurrentRun(run);
        if (isTerminalRunStatus(run.status)) {
          setRunning(false);
          finish();
        }
      };

      const applyEvent = (event: RunEventRecord) => {
        if (event.sequence <= lastEventSequence) return;
        lastEventSequence = event.sequence;
        setLastRunEventSequence(event.sequence);
        if (event.message) {
          const prefix = event.type === 'run.log' ? '' : `[${event.type}] `;
          addLog(`${prefix}${event.message}`);
        }
      };

      const pollRun = async () => {
        try {
          const response = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
          const body = await response.json() as { run?: RunRecord; events?: RunEventRecord[] };
          if (body.run) applyRun(body.run);
          body.events?.forEach(applyEvent);
        } catch {
          // The next interval retries while the durable run remains active.
        }
      };

      events.onmessage = (message) => {
        try {
          const data = JSON.parse(message.data) as RunEventEnvelope;
          if (data.error) addLog(`ERROR: ${data.error}`);
          if (data.run) applyRun(data.run);
          if (data.event) applyEvent(data.event);
        } catch (e) {
          addLog(`[parse error] ${e}`);
        }
      };

      events.onerror = () => {
        if (settled) return;
        addLog('Live events disconnected; continuing with durable run polling.');
        events.close();
        void pollRun();
        pollTimer = setInterval(() => void pollRun(), 3000);
      };
    });
  }, [addLog]);

  function applyPersistedSection(section: CredentialSection, state: PersistedSectionState) {
    const setString = (key: string, setter: (value: string) => void) => {
      if (typeof state[key] === 'string') setter(state[key] as string);
    };
    const setBoolean = (key: string, setter: (value: boolean) => void) => {
      if (typeof state[key] === 'boolean') setter(state[key] as boolean);
    };

    if (section === 'source') {
      setString('pat', setPat);
      setString('targetName', setTargetName);
      setString('matchRegex', setMatchRegex);
      setString('topics', setTopics);
      setString('targetType', (value) => {
        if (value === 'user' || value === 'org') setTargetType(value);
      });
      setString('visibility', (value) => {
        if (value === 'all' || value === 'public' || value === 'private') setVisibility(value);
      });
      setBoolean('skipForks', setSkipForks);
      setBoolean('skipArchived', setSkipArchived);
      setBoolean('dryRun', setDryRun);
      setBoolean('metadataEnabled', setMetadataEnabled);
      if (Array.isArray(state.metadataTypes)) {
        const metadataTypeValues = state.metadataTypes.filter((v): v is string => typeof v === 'string');
        queueMicrotask(() => {
          setMetadataTypes(new Set(metadataTypeValues));
        });
      }
      return;
    }

    if (section === 'r2') {
      setBoolean('r2On', setR2On);
      setString('r2AccountId', setR2AccountId);
      setString('r2AccessKey', setR2AccessKey);
      setString('r2SecretKey', setR2SecretKey);
      setString('r2Bucket', setR2Bucket);
      return;
    }

    if (section === 's3') {
      setBoolean('s3On', setS3On);
      setString('s3Region', setS3Region);
      setString('s3AccessKey', setS3AccessKey);
      setString('s3SecretKey', setS3SecretKey);
      setString('s3Bucket', setS3Bucket);
      return;
    }

    if (section === 'gdrive') {
      setBoolean('gdriveOn', setGdriveOn);
      setString('gdriveEmail', setGdriveEmail);
      setString('gdriveKey', setGdriveKey);
      setString('gdriveFolderId', setGdriveFolderId);
      return;
    }

    if (section === 'githubTarget') {
      setBoolean('ghOn', setGhOn);
      setString('ghOwner', setGhOwner);
      setString('ghRepo', setGhRepo);
      setString('ghBranch', setGhBranch);
      setString('ghPat', setGhPat);
      return;
    }

    setBoolean('azureOn', setAzureOn);
    setString('azureConn', setAzureConn);
    setString('azureContainer', setAzureContainer);
  }

  useEffect(() => {
    try {
      if (!canUseLocalStorage()) {
        queueMicrotask(() => {
          setStorageAvailable(false);
          setCredentialSaveStatus({ source: 'Browser storage is unavailable in this mode.' });
        });
        return;
      }

      const legacyState = readStoredSection(LEGACY_FORM_STORAGE_KEY);
      const restored: CredentialStatusMap = {};
      for (const section of Object.keys(CREDENTIAL_STORAGE_KEYS) as CredentialSection[]) {
        const state = readStoredSection(CREDENTIAL_STORAGE_KEYS[section]) ?? legacyState;
        if (state) {
          applyPersistedSection(section, state);
          restored[section] = 'Saved values restored from this browser.';
        }
      }

      if (Object.keys(restored).length) {
        queueMicrotask(() => {
          setCredentialSaveStatus(restored);
        });
      }
    } catch {
      try {
        Object.values(CREDENTIAL_STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
        localStorage.removeItem(LEGACY_FORM_STORAGE_KEY);
      } catch {
        queueMicrotask(() => {
          setStorageAvailable(false);
        });
      }
      queueMicrotask(() => {
        setCredentialSaveStatus({ source: 'Saved credentials were unreadable and were cleared.' });
      });
    } finally {
      setFormHydrated(true);
    }
  }, []);

  useEffect(() => {
    try {
      if (!canUseLocalStorage()) {
        queueMicrotask(() => {
          setRunCacheStatus('Browser run cache is unavailable in this mode.');
          setRunCacheHydrated(true);
        });
        return;
      }

      const cache = readRunCache();
      const active = cache.activeRunId ? cache.runs[cache.activeRunId] : latestCachedRun(cache);
      queueMicrotask(() => {
        if (active) {
          setCurrentRun(active.run);
          setLogs(active.logs);
          setSummary(active.summary);
          setLastRunEventSequence(active.lastEventSequence ?? 0);
          setRunCacheStatus(`Restored run ${active.run.id.slice(0, 8)} from this browser.`);

          if (!isTerminalRunStatus(active.run.status)) {
            setRunning(true);
            void watchRun(active.run.id, active.lastEventSequence ?? 0);
          }
        }
        setRunCacheHydrated(true);
      });
    } catch {
      queueMicrotask(() => {
        setRunCacheStatus('Saved run cache was unreadable and was ignored.');
        setRunCacheHydrated(true);
      });
    }
  }, [watchRun]);

  useEffect(() => {
    if (!runCacheHydrated || !currentRun || !storageAvailable) return;

    try {
      const cache = readRunCache();
      cache.activeRunId = currentRun.id;
      cache.runs[currentRun.id] = {
        run: currentRun,
        logs: logs.slice(-MAX_CACHED_LOG_LINES),
        summary,
        lastEventSequence: lastRunEventSequence,
        updatedAt: new Date().toISOString(),
      };
      writeRunCache(cache);
    } catch {
      queueMicrotask(() => {
        setRunCacheStatus('Unable to save run state in this browser.');
      });
    }
  }, [currentRun, lastRunEventSequence, logs, runCacheHydrated, storageAvailable, summary]);

  function countAdapters() {
    return [r2On, s3On, gdriveOn, ghOn, azureOn].filter(Boolean).length;
  }

  async function fetchRepositories() {
    if ((!pat && !auth?.hasToken) || !targetName) return;
    setLoadingRepositories(true);
    setRepositoryError('');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = window.setTimeout(() => controller?.abort(), REPOSITORY_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch('/api/github/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller?.signal,
        body: JSON.stringify({
          pat, targetType, targetName, visibility, skipForks, skipArchived,
          matchRegex: matchRegex || undefined,
          topics: topics ? topics.split(',').map((topic) => topic.trim()).filter(Boolean) : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        const details = [body.error, body.hint, body.rateLimitResetAt ? `Rate-limit reset: ${body.rateLimitResetAt}` : null]
          .filter(Boolean)
          .join(' ');
        throw new Error(details || `Repository lookup failed (${response.status})`);
      }
      const next = body.repositories as RepositoryChoice[];
      setRepositories(next);
      setSelectedRepositories(new Set(next.map((repo) => repo.name)));
      setBranchOverrides(Object.fromEntries(next.map((repo) => [repo.name, repo.defaultBranch])));
      setRepoListOpen(false);
    } catch (error) {
      setRepositoryError(error instanceof DOMException && error.name === 'AbortError'
        ? 'Repository lookup timed out. GitHub may be rate-limiting or denying this token; check PAT org access, SSO authorization, and retry shortly.'
        : error instanceof Error ? error.message : String(error));
    } finally {
      window.clearTimeout(timeout);
      setLoadingRepositories(false);
    }

  }

  async function loadBranches(repo: RepositoryChoice) {
    if (repo.branches?.length || loadingBranches) return;
    setLoadingBranches(repo.name);
    setRepositoryError('');
    try {
      const response = await fetch('/api/github/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pat, owner: repo.owner, repo: repo.name }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`${repo.name}: ${body.error ?? 'Unable to fetch branches'}`);
      setRepositories((current) => current.map((item) => item.name === repo.name
        ? { ...item, branches: body.branches as string[] }
        : item));
    } catch (error) {
      setRepositoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingBranches(null);
    }
  }

  function toggleRepository(name: string) {
    setSelectedRepositories((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
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

  function buildPersistedSectionState(section: CredentialSection): PersistedSectionState {
    const savedAt = new Date().toISOString();
    if (section === 'source') {
      return {
        pat, targetType, targetName, visibility, skipForks, skipArchived, dryRun, captureMode,
        matchRegex, topics, metadataEnabled, metadataTypes: [...metadataTypes], savedAt,
      };
    }
    if (section === 'r2') {
      return { r2On, r2AccountId, r2AccessKey, r2SecretKey, r2Bucket, savedAt };
    }
    if (section === 's3') {
      return { s3On, s3Region, s3AccessKey, s3SecretKey, s3Bucket, savedAt };
    }
    if (section === 'gdrive') {
      return { gdriveOn, gdriveEmail, gdriveKey, gdriveFolderId, savedAt };
    }
    if (section === 'githubTarget') {
      return { ghOn, ghOwner, ghRepo, ghBranch, ghPat, savedAt };
    }
    return { azureOn, azureConn, azureContainer, savedAt };
  }

  function setSectionStatus(section: CredentialSection, message: string) {
    setCredentialSaveStatus((prev) => ({ ...prev, [section]: message }));
  }

  function saveCredentialSection(section: CredentialSection) {
    if (!canUseLocalStorage()) {
      setStorageAvailable(false);
      setSectionStatus(section, 'Browser storage is unavailable in this mode.');
      return;
    }

    try {
      localStorage.setItem(CREDENTIAL_STORAGE_KEYS[section], JSON.stringify(buildPersistedSectionState(section)));
      setStorageAvailable(true);
      setSectionStatus(section, 'Saved in this browser.');
    } catch {
      setStorageAvailable(false);
      setSectionStatus(section, 'Unable to save. Browser storage may be blocked or full.');
    }
  }

  function clearCredentialSection(section: CredentialSection) {
    try {
      localStorage.removeItem(CREDENTIAL_STORAGE_KEYS[section]);
      setSectionStatus(section, 'Saved values cleared from this browser.');
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
      setSectionStatus(section, 'Unable to clear because browser storage is blocked.');
    }
  }

  function clearDisplayedRun() {
    setLogs([]);
    setSummary(null);
    setCurrentRun(null);
    setLastRunEventSequence(0);
    setRunCacheStatus('');
    try {
      const cache = readRunCache();
      delete cache.activeRunId;
      writeRunCache(cache);
    } catch {
      // Clearing the visible run should still work when browser storage is unavailable.
    }
  }

  async function startExtraction() {
    if (!pat || !targetName) return;
    setRunning(true);
    setLogs([]);
    setSummary(null);
    setCurrentRun(null);
    setLastRunEventSequence(0);

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pat,
          targetType,
          targetName,
          adapters: buildAdapterConfig(),
          options: {
            captureMode,
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
            selectedRepositories: repositories.length ? [...selectedRepositories] : undefined,
            branchOverrides: repositories.length ? branchOverrides : undefined,
          },
        }),
      });

      const body = await res.json();
      if (!body.run) {
        const apiError = typeof body.error === 'string'
          ? body.error
          : body.error?.message ?? body.error?.code ?? `Request failed with HTTP ${res.status}`;
        throw new Error(apiError);
      }
      setCurrentRun(body.run);

      if (body.preflight?.warnings?.length) {
        body.preflight.warnings.forEach((warning: string) => addLog(`[warn] ${warning}`));
      }
      if (body.preflight?.adapters?.length) {
        body.preflight.adapters.forEach((adapter: { adapter: string; writable: boolean; message?: string; errorCode?: string }) => {
          addLog(`${adapter.writable ? '[preflight ok]' : '[preflight failed]'} ${adapter.adapter}: ${adapter.message ?? adapter.errorCode ?? ''}`);
        });
      }

      addLog(`Run ID: ${body.run.id}`);
      if (!res.ok || body.run.status === 'preflight_failed') {
        addLog(`ERROR: ${body.run.errorMessage ?? body.error ?? 'Preflight failed'}`);
        setRunning(false);
        return;
      }

      addLog('[worker] Platform worker dispatch requested. Runs may remain queued briefly until a worker claims the job.');

      await watchRun(body.run.id);
    } catch (e) {
      addLog(`Connection error: ${e instanceof Error ? e.message : String(e)}`);
      setRunning(false);
    }
  }

  async function cancelRun() {
    if (!currentRun || !running) return;
    try {
      const res = await fetch(`/api/runs/${currentRun.id}/cancel`, { method: 'POST' });
      const body = await res.json();
      if (body.run) setCurrentRun(body.run);
      addLog('Cancellation requested');
    } catch (e) {
      addLog(`ERROR: ${e}`);
    } finally {
      setRunning(false);
    }
  }

  async function copyLogs() {
    const actualError = summarizeActualError(logs, currentRun);
    const logExport = buildLogExport({ logs, currentRun, actualError });
    if (!logs.length) {
      setLogActionStatus('No logs to copy yet.');
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(logExport);
      } else if (!fallbackCopyText(logExport)) {
        throw new Error('clipboard unavailable');
      }
      setLogActionStatus('Logs copied.');
    } catch {
      setLogActionStatus('Unable to copy logs in this browser.');
    }
  }

  function downloadLogs() {
    const actualError = summarizeActualError(logs, currentRun);
    const logExport = buildLogExport({ logs, currentRun, actualError });
    if (!logs.length) {
      setLogActionStatus('No logs to download yet.');
      return;
    }

    const blob = new Blob([logExport], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `detiq-gce-${currentRun?.id ?? 'run'}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setLogActionStatus('Log file downloaded.');
  }

  const canRun = Boolean(
    (pat || auth?.hasToken) &&
    targetName &&
    repositories.length > 0 &&
    selectedRepositories.size > 0 &&
    (dryRun || countAdapters() > 0)
  );
  const actualError = summarizeActualError(logs, currentRun);
  const queuedNeedsWorker = running && currentRun?.status === 'queued';
  const filteredRepositories = repositories.filter((repo) => {
    const query = repoSearch.toLowerCase();
    return !query || repo.name.toLowerCase().includes(query) || repo.topics.some((topic) => topic.toLowerCase().includes(query));
  });
  const selectedRepositoryNames = repositories
    .filter((repo) => selectedRepositories.has(repo.name))
    .map((repo) => repo.name);
  const hiddenRoutineLogCount = logs.filter(isRoutineLogLine).length;
  const visibleLogs = logs.filter((log) => !isRoutineLogLine(log));
  const workerStatusLine = latestStatusLine(logs);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-3 shadow-sm">
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
          <div className="flex items-center gap-4">
            <a href="https://github.com/deepanimators/Detiq-GCE" target="_blank" rel="noopener noreferrer"
              className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
              GitHub ↗
            </a>
            {auth?.authenticated && auth.user ? (
              <div className="flex items-center gap-3">
                <img src={auth.user.avatar_url} alt={auth.user.login} className="w-6 h-6 rounded-full" />
                <span className="text-xs text-zinc-600 dark:text-zinc-300">{auth.user.login}</span>
                <form action="/api/auth/logout" method="POST">
                  <button type="submit" className="text-xs text-red-500 hover:text-red-700">Logout</button>
                </form>
              </div>
            ) : (
              <a href="/api/auth/github" className="text-xs bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-3 py-1.5 rounded-lg font-medium hover:opacity-90">
                Login with GitHub
              </a>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 grid grid-cols-1 xl:grid-cols-[minmax(0,500px)_minmax(0,1fr)] gap-6 items-start [overflow-anchor:none]">

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

            <div className="flex flex-wrap gap-4 border-t border-zinc-100 dark:border-zinc-800 pt-3">
              <div className="w-full">
                <label className="block text-xs text-zinc-500 mb-1">Capture Mode</label>
                <select value={captureMode} onChange={(e) => setCaptureMode(e.target.value as 'mirror' | 'selective-api' | 'metadata-only')}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900">
                  <option value="mirror">Mirror Bundle (Recommended for full backup)</option>
                  <option value="selective-api">Selective Files (REST API)</option>
                  <option value="metadata-only">Metadata Only</option>
                </select>
              </div>
              <Check label="Skip forks" checked={skipForks} onChange={setSkipForks} />
              <Check label="Skip archived" checked={skipArchived} onChange={setSkipArchived} />
              <Check label="Dry run" checked={dryRun} onChange={setDryRun} />
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-zinc-100 dark:border-zinc-800 pt-3">
              <div>
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Repository selection</p>
                <p className="text-xs text-zinc-400">Fetch metadata, choose repositories, and set a branch per repository.</p>
              </div>
              <button type="button" onClick={fetchRepositories}
                className="px-3 py-2 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                disabled={(!pat && !auth?.hasToken) || !targetName || loadingRepositories}>
                {loadingRepositories ? 'Fetching…' : 'Fetch repositories'}
              </button>
            </div>
            {repositoryError && <p role="alert" className="text-xs text-red-600">{repositoryError}</p>}
            {repositories.length > 0 && (
              <div className="space-y-2">
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-900/60 p-3 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        {selectedRepositories.size}/{repositories.length} repositories selected
                      </p>
                      <p className="text-xs text-zinc-400">
                        {repoListOpen ? `${filteredRepositories.length} shown after filters.` : 'Repository rows are collapsed to keep the page short.'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRepoListOpen((open) => !open)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      aria-expanded={repoListOpen}
                    >
                      {repoListOpen ? 'Hide list' : 'Review selection'}
                    </button>
                  </div>

                  {!repoListOpen && (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedRepositoryNames.slice(0, 4).map((name) => (
                        <span key={name} className="max-w-full truncate rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300">
                          {name}
                        </span>
                      ))}
                      {selectedRepositoryNames.length > 4 && (
                        <span className="rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-500">
                          +{selectedRepositoryNames.length - 4} more
                        </span>
                      )}
                    </div>
                  )}

                  {repoListOpen && (
                    <div className="space-y-2">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                        <Field label="Search repositories" value={repoSearch} onChange={setRepoSearch} placeholder="Filter by name or topic" />
                        <span className="pb-2 text-xs text-zinc-500 whitespace-nowrap">{filteredRepositories.length} shown</span>
                      </div>
                      <div className="max-h-56 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 divide-y divide-zinc-100 dark:divide-zinc-800">
                        {filteredRepositories.map((repo) => (
                          <div key={repo.name} className="grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_9rem] items-center gap-3 px-3 py-2">
                            <input type="checkbox" checked={selectedRepositories.has(repo.name)}
                              onChange={() => toggleRepository(repo.name)} aria-label={`Select ${repo.name}`} />
                            <div className="min-w-0">
                              <p className="text-sm text-zinc-800 dark:text-zinc-200 truncate">{repo.name}</p>
                              <p className="text-[11px] text-zinc-400 truncate">{repo.isPrivate ? 'Private' : 'Public'} · default: {repo.defaultBranch}</p>
                            </div>
                            <input list={`branches-${repo.name}`} className="col-span-2 sm:col-span-1 w-full px-2 py-1 text-xs rounded border border-zinc-200 dark:border-zinc-700 bg-transparent"
                              value={branchOverrides[repo.name] ?? repo.defaultBranch}
                              onFocus={() => void loadBranches(repo)}
                              onChange={(event) => setBranchOverrides((current) => ({ ...current, [repo.name]: event.target.value }))}
                              aria-label={`Branch for ${repo.name}`} />
                            <datalist id={`branches-${repo.name}`}>
                              {(repo.branches ?? [repo.defaultBranch]).map((branch) => <option key={branch} value={branch} />)}
                            </datalist>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <SectionStorageActions
              label="source"
              status={credentialSaveStatus.source}
              disabled={!formHydrated || !storageAvailable}
              onSave={() => saveCredentialSection('source')}
              onClear={() => clearCredentialSection('source')}
            />
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
              <SectionStorageActions
                label="R2"
                status={credentialSaveStatus.r2}
                disabled={!formHydrated || !storageAvailable}
                onSave={() => saveCredentialSection('r2')}
                onClear={() => clearCredentialSection('r2')}
              />
            </AdapterToggle>

            <AdapterToggle label="AWS S3" logo="🟡" enabled={s3On} onToggle={() => setS3On(!s3On)}>
              <Field label="Region" value={s3Region} onChange={setS3Region} placeholder="us-east-1" />
              <Field label="Access Key ID" value={s3AccessKey} onChange={setS3AccessKey} type="password" placeholder="AKIA..." />
              <Field label="Secret Access Key" value={s3SecretKey} onChange={setS3SecretKey} type="password" placeholder="secret" />
              <Field label="Bucket Name" value={s3Bucket} onChange={setS3Bucket} placeholder="my-github-backup" />
              <SectionStorageActions
                label="S3"
                status={credentialSaveStatus.s3}
                disabled={!formHydrated || !storageAvailable}
                onSave={() => saveCredentialSection('s3')}
                onClear={() => clearCredentialSection('s3')}
              />
            </AdapterToggle>

            <AdapterToggle label="Google Drive" logo="🔵" enabled={gdriveOn} onToggle={() => setGdriveOn(!gdriveOn)}>
              <Field label="Service Account Email" value={gdriveEmail} onChange={setGdriveEmail}
                placeholder="backup@myproject.iam.gserviceaccount.com" />
              <Textarea label="Private Key (full key with BEGIN/END lines)" value={gdriveKey} onChange={setGdriveKey}
                placeholder={"-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----"} rows={5} secret />
              <Field label="Root Folder ID" value={gdriveFolderId} onChange={setGdriveFolderId}
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUq..." mono
                hint="From Drive URL: .../folders/THIS_PART — share folder with service account email" />
              <SectionStorageActions
                label="Drive"
                status={credentialSaveStatus.gdrive}
                disabled={!formHydrated || !storageAvailable}
                onSave={() => saveCredentialSection('gdrive')}
                onClear={() => clearCredentialSection('gdrive')}
              />
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
              <SectionStorageActions
                label="GitHub target"
                status={credentialSaveStatus.githubTarget}
                disabled={!formHydrated || !storageAvailable}
                onSave={() => saveCredentialSection('githubTarget')}
                onClear={() => clearCredentialSection('githubTarget')}
              />
            </AdapterToggle>

            <AdapterToggle label="Azure Blob Storage" logo="🔷" enabled={azureOn} onToggle={() => setAzureOn(!azureOn)}>
              <Textarea label="Connection String" value={azureConn} onChange={setAzureConn}
                placeholder="DefaultEndpointsProtocol=https;AccountName=xxx;AccountKey=xxx;EndpointSuffix=core.windows.net"
                rows={3} secret />
              <Field label="Container Name" value={azureContainer} onChange={setAzureContainer} placeholder="github-backup"
                hint="Created automatically if it doesn't exist" />
              <SectionStorageActions
                label="Azure"
                status={credentialSaveStatus.azure}
                disabled={!formHydrated || !storageAvailable}
                onSave={() => saveCredentialSection('azure')}
                onClear={() => clearCredentialSection('azure')}
              />
            </AdapterToggle>
          </div>

          {!canRun && !running && (
            <p className="text-xs text-amber-600 dark:text-amber-400 px-1">
              {!pat ? '→ Enter GitHub PAT' : !targetName ? '→ Enter org or username' : !repositories.length ? '→ Fetch repositories first' : !selectedRepositories.size ? '→ Select at least one repository' : '→ Enable at least one storage target (or check Dry run)'}
            </p>
          )}

          <Button onClick={startExtraction} disabled={running || Boolean(loadingBranches) || !canRun} className="w-full h-10">
            {running
              ? 'Run active...'
              : `Create Backup Run${countAdapters() > 1 ? ` → ${countAdapters()} targets` : ''}${metadataEnabled ? ' + metadata' : ''}`}
          </Button>
          <p className="text-[11px] text-zinc-400 px-1">
            Save controls are section-specific. Browser storage keeps only the sections you save.
          </p>

        </div>

        {/* ── Right: live log ────────────────────────────────────────────── */}
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 flex flex-col min-h-[24rem] xl:sticky xl:top-20 xl:h-[calc(100svh-6rem)] xl:max-h-[calc(100svh-6rem)] xl:min-h-0 xl:z-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Live Log</h2>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {currentRun && (
                <span className="text-xs text-zinc-400 font-mono">{currentRun.id.slice(0, 8)}</span>
              )}
              {running && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {currentRun?.status ?? 'Queued'}
                </span>
              )}
              {running && currentRun && (
                <button onClick={cancelRun} className="text-xs text-red-500 hover:text-red-700">Cancel</button>
              )}
              {logs.length > 0 && (
                <>
                  <Button type="button" size="xs" variant="outline" onClick={copyLogs}>
                    <ClipboardCopy data-icon="inline-start" />
                    Copy
                  </Button>
                  <Button type="button" size="xs" variant="outline" onClick={downloadLogs}>
                    <Download data-icon="inline-start" />
                    Download
                  </Button>
                </>
              )}
              {!running && logs.length > 0 && (
                <button onClick={clearDisplayedRun}
                  className="text-xs text-zinc-400 hover:text-zinc-600">Clear</button>
              )}
            </div>
          </div>

          {(queuedNeedsWorker || actualError || logActionStatus || runCacheStatus || workerStatusLine) && (
            <div className="border-b border-zinc-100 dark:border-zinc-800 px-4 py-3 flex-shrink-0 space-y-1 bg-zinc-50 dark:bg-zinc-900">
              {queuedNeedsWorker && (
                <p className="text-xs text-amber-600 dark:text-amber-400 break-words">
                  <span className="font-semibold">Waiting for worker:</span> the platform worker has not claimed this run yet. It should start automatically; if it does not, contact the platform administrator.
                </p>
              )}
              {workerStatusLine && (
                <p className="text-xs text-zinc-600 dark:text-zinc-300 break-words">
                  <span className="font-semibold">Worker status:</span> {workerStatusLine.replace(/^\[worker\]\s*/, '')}
                </p>
              )}
              {actualError && (
                <p className="text-xs text-red-600 dark:text-red-400 break-words">
                  <span className="font-semibold">Actual error:</span> {actualError}
                </p>
              )}
              {logActionStatus && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{logActionStatus}</p>
              )}
              {runCacheStatus && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{runCacheStatus}</p>
              )}
            </div>
          )}

          <div ref={logScrollRef} className="flex-1 overflow-y-auto p-4 pb-6 font-mono text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 min-h-0 [overflow-anchor:none]">
            {logs.length === 0 && !running && (
              <p className="text-zinc-400 text-center mt-20 font-sans text-sm">
                Configure source + storage targets, then click Start.
              </p>
            )}
            {visibleLogs.length === 0 && logs.length > 0 && (
              <p className="text-zinc-400 text-center mt-20 font-sans text-sm">
                Only routine platform messages so far.
              </p>
            )}
            {visibleLogs.map((log, i) => (
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
            {hiddenRoutineLogCount > 0 && (
              <details className="mt-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 font-sans">
                <summary className="cursor-pointer text-xs text-zinc-500 dark:text-zinc-400">
                  Show {hiddenRoutineLogCount} routine platform message{hiddenRoutineLogCount === 1 ? '' : 's'}
                </summary>
                <div className="mt-2 space-y-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {logs.filter(isRoutineLogLine).map((log, i) => (
                    <div key={`${i}-${log}`} className="break-words">{log}</div>
                  ))}
                </div>
              </details>
            )}
          </div>

          {summary && (
            <div className="border-t border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex-shrink-0">
              <div className="grid grid-cols-3 gap-2 mb-2">
                {[
                  { label: 'Repos', value: `${summary.successRepos}/${summary.totalRepos}`, ok: summary.successRepos === summary.totalRepos },
                  { label: 'Uploaded', value: summary.uploadedFiles, ok: true },
                  { label: 'Failed', value: summary.failedFiles, ok: summary.failedFiles === 0 },
                ].map((s) => (
                  <div key={s.label} className="text-center bg-zinc-50 dark:bg-zinc-800 rounded-lg py-2 min-w-0">
                    <div className={`text-xl font-semibold ${s.ok ? 'text-zinc-900 dark:text-zinc-50' : 'text-red-500'}`}>{s.value}</div>
                    <div className="text-xs text-zinc-500">{s.label}</div>
                  </div>
                ))}
              </div>
              {(summary.skippedFiles > 0 || summary.totalFiles > 0) && (
                <p className="text-xs text-zinc-400 text-center">
                  {summary.totalFiles} total files{summary.totalFolders ? ` · ${summary.totalFolders} folders` : ''}{summary.skippedFiles > 0 ? ` · ${summary.skippedFiles} skipped` : ''}
                  {summary.skippedExistingFiles ? ` · ${summary.skippedExistingFiles} already copied` : ''}
                </p>
              )}
            </div>
          )}

          {currentRun && !summary && (
            <div className="border-t border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex-shrink-0">
              <div className="grid grid-cols-3 gap-2 mb-2">
                {[
                  { label: 'Status', value: currentRun.status, ok: !['failed', 'partial', 'preflight_failed'].includes(currentRun.status) },
                  { label: 'Repos', value: `${currentRun.completedRepos}/${currentRun.discoveredRepos || currentRun.estimatedRepos}`, ok: currentRun.failedRepos === 0 },
                  { label: 'Failed', value: currentRun.failedRepos, ok: currentRun.failedRepos === 0 },
                ].map((s) => (
                  <div key={s.label} className="text-center bg-zinc-50 dark:bg-zinc-800 rounded-lg py-2 min-w-0">
                    <div className={`text-sm font-semibold truncate px-1 ${s.ok ? 'text-zinc-900 dark:text-zinc-50' : 'text-red-500'}`}>{s.value}</div>
                    <div className="text-xs text-zinc-500">{s.label}</div>
                  </div>
                ))}
              </div>
              {currentRun.errorMessage && (
                <p className="text-xs text-red-500 text-center break-words">{currentRun.errorMessage}</p>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="relative z-10 max-w-6xl mx-auto px-6 py-4 text-xs text-zinc-400 border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 mt-2">
        Backup runs are queued and processed automatically by the platform.
      </footer>
    </div>
  );
}
