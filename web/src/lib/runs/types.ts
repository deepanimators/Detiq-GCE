import type { AdapterConfig } from '@/lib/adapters';

export type RunStatus =
  | 'queued'
  | 'preflight_failed'
  | 'running'
  | 'paused'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type CaptureProfile = 'code' | 'mirror' | 'metadata' | 'compliance' | 'custom';

export type RunEventType =
  | 'run.created'
  | 'run.preflight_failed'
  | 'run.queued'
  | 'run.started'
  | 'run.log'
  | 'run.completed'
  | 'run.partial'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.cancel_requested'
  | 'artifact.verified';

export type QueuedRun = {
  runId: string;
  payload: RunCreatePayload;
  repositories: import('@/lib/github').Repo[];
  enqueuedAt: string;
};

export type ExtractOptions = {
  skipForks?: boolean;
  skipArchived?: boolean;
  dryRun?: boolean;
  visibility?: 'all' | 'public' | 'private';
  matchRegex?: string;
  topics?: string[];
  maxFileSizeKb?: number;
  repoConcurrency?: number;
  fileConcurrency?: number;
  useDefaultExcludes?: boolean;
  extraExcludes?: string[];
  metadata?: boolean;
  metadataTypes?: string;
  selectedRepositories?: string[];
  branchOverrides?: Record<string, string>;
};

export type RunCreatePayload = {
  pat: string;
  targetType: 'user' | 'org';
  targetName: string;
  adapters: AdapterConfig;
  options: ExtractOptions;
};

export type RedactedRunConfig = {
  targetType: 'user' | 'org';
  targetName: string;
  adapterNames: string[];
  options: ExtractOptions;
};

export type BackupRunRecord = {
  id: string;
  tenantId: string;
  status: RunStatus;
  profile: CaptureProfile;
  sourceType: 'user' | 'org';
  sourceName: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  extractorVersion?: string;
  githubApiVersion?: string;
  estimatedRepos: number;
  discoveredRepos: number;
  completedRepos: number;
  partialRepos: number;
  failedRepos: number;
  bytesUploaded: number;
  errorCode?: string;
  errorMessage?: string;
  config: RedactedRunConfig;
};

export type RunEvent = {
  id: string;
  runId: string;
  sequence: number;
  type: RunEventType;
  createdAt: string;
  message?: string;
  repository?: string;
  stage?: string;
  adapter?: string;
  errorCode?: string;
  retryCount?: number;
  durationMs?: number;
  bytes?: number;
  rateLimitRemaining?: number;
};

export type StoredRun = {
  run: BackupRunRecord;
  events: RunEvent[];
};
