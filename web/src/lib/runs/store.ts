import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import type { BackupRunRecord, RunEvent, RunEventType, StoredRun } from './types';
import { getRunObjectStore, getRunObject, putRunObject } from './object-store';

export type RunUpdate = Partial<Omit<BackupRunRecord, 'id' | 'createdAt' | 'config'>>;

export interface RunStore {
  createRun(run: BackupRunRecord): Promise<BackupRunRecord>;
  getRun(runId: string): Promise<StoredRun | null>;
  updateRun(runId: string, patch: RunUpdate): Promise<BackupRunRecord>;
  appendEvent(runId: string, event: Omit<RunEvent, 'id' | 'runId' | 'sequence' | 'createdAt'>): Promise<RunEvent>;
  getEvents(runId: string, afterSequence?: number): Promise<RunEvent[]>;
}

export class RunStoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStoreConfigurationError';
  }
}

class FileRunStore implements RunStore {
  constructor(private readonly rootDir: string) {}

  async createRun(run: BackupRunRecord): Promise<BackupRunRecord> {
    const stored: StoredRun = { run, events: [] };
    await this.write(run.id, stored);
    return run;
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    try {
      const raw = await readFile(this.filePath(runId), 'utf8');
      return JSON.parse(raw) as StoredRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async updateRun(runId: string, patch: RunUpdate): Promise<BackupRunRecord> {
    const stored = await this.requireRun(runId);
    stored.run = { ...stored.run, ...patch };
    await this.write(runId, stored);
    return stored.run;
  }

  async appendEvent(
    runId: string,
    event: Omit<RunEvent, 'id' | 'runId' | 'sequence' | 'createdAt'>
  ): Promise<RunEvent> {
    const stored = await this.requireRun(runId);
    const lastSequence = stored.events.at(-1)?.sequence ?? 0;
    const next: RunEvent = {
      ...event,
      id: crypto.randomUUID(),
      runId,
      sequence: lastSequence + 1,
      createdAt: new Date().toISOString(),
    };
    stored.events.push(next);
    await this.write(runId, stored);
    return next;
  }

  async getEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    const stored = await this.getRun(runId);
    if (!stored) return [];
    return stored.events.filter((event) => event.sequence > afterSequence);
  }

  private async requireRun(runId: string): Promise<StoredRun> {
    const stored = await this.getRun(runId);
    if (!stored) throw new Error(`Run not found: ${runId}`);
    return stored;
  }

  private async write(runId: string, stored: StoredRun): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.filePath(runId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(stored, null, 2), 'utf8');
    await rename(tmp, target);
  }

  private filePath(runId: string): string {
    return path.join(this.rootDir, `${safeRunId(runId)}.json`);
  }
}

class RedisRunStore implements RunStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = 'detiq:run'
  ) {}

  async createRun(run: BackupRunRecord): Promise<BackupRunRecord> {
    await this.pipeline([
      ['SET', this.runKey(run.id), JSON.stringify(run)],
      ['DEL', this.eventsKey(run.id), this.sequenceKey(run.id)],
    ]);
    return run;
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    const [runResult, eventsResult] = await this.pipeline([
      ['GET', this.runKey(runId)],
      ['LRANGE', this.eventsKey(runId), '0', '-1'],
    ]);
    if (!runResult.result) return null;

    const events = (eventsResult.result as unknown[]).map((event) => JSON.parse(String(event)) as RunEvent);
    return {
      run: JSON.parse(String(runResult.result)) as BackupRunRecord,
      events,
    };
  }

  async updateRun(runId: string, patch: RunUpdate): Promise<BackupRunRecord> {
    const stored = await this.requireRun(runId);
    const run = { ...stored.run, ...patch };
    await this.command(['SET', this.runKey(runId), JSON.stringify(run)]);
    return run;
  }

  async appendEvent(
    runId: string,
    event: Omit<RunEvent, 'id' | 'runId' | 'sequence' | 'createdAt'>
  ): Promise<RunEvent> {
    await this.requireRun(runId);
    const sequenceResult = await this.command(['INCR', this.sequenceKey(runId)]);
    const next: RunEvent = {
      ...event,
      id: crypto.randomUUID(),
      runId,
      sequence: Number(sequenceResult.result),
      createdAt: new Date().toISOString(),
    };
    await this.command(['RPUSH', this.eventsKey(runId), JSON.stringify(next)]);
    return next;
  }

  async getEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    const stored = await this.getRun(runId);
    return stored?.events.filter((event) => event.sequence > afterSequence) ?? [];
  }

  private async requireRun(runId: string): Promise<StoredRun> {
    const stored = await this.getRun(runId);
    if (!stored) throw new Error(`Run not found: ${runId}`);
    return stored;
  }

  private runKey(runId: string): string {
    return `${this.prefix}:${safeRunId(runId)}`;
  }

  private eventsKey(runId: string): string {
    return `${this.runKey(runId)}:events`;
  }

  private sequenceKey(runId: string): string {
    return `${this.runKey(runId)}:sequence`;
  }

  private async command(command: string[]): Promise<RedisResponse> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });
    return parseRedisResponse(response);
  }

  private async pipeline(commands: string[][]): Promise<RedisResponse[]> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    const result = await response.json() as unknown;
    if (!response.ok || !Array.isArray(result)) {
      throw new Error(`Run store request failed (${response.status}).`);
    }
    return result.map((entry) => parseRedisPayload(entry));
  }
}

class ObjectRunStore implements RunStore {
  async createRun(run: BackupRunRecord): Promise<BackupRunRecord> {
    await this.write(run.id, { run, events: [] });
    return run;
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    const raw = await getRunObject(`runs/${safeRunId(runId)}.json`);
    return raw ? JSON.parse(raw) as StoredRun : null;
  }

  async updateRun(runId: string, patch: RunUpdate): Promise<BackupRunRecord> {
    const stored = await this.requireRun(runId);
    stored.run = { ...stored.run, ...patch };
    await this.write(runId, stored);
    return stored.run;
  }

  async appendEvent(
    runId: string,
    event: Omit<RunEvent, 'id' | 'runId' | 'sequence' | 'createdAt'>
  ): Promise<RunEvent> {
    const stored = await this.requireRun(runId);
    const next: RunEvent = {
      ...event,
      id: crypto.randomUUID(),
      runId,
      sequence: (stored.events.at(-1)?.sequence ?? 0) + 1,
      createdAt: new Date().toISOString(),
    };
    stored.events.push(next);
    await this.write(runId, stored);
    return next;
  }

  async getEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    const stored = await this.getRun(runId);
    return stored?.events.filter((event) => event.sequence > afterSequence) ?? [];
  }

  private async requireRun(runId: string): Promise<StoredRun> {
    const stored = await this.getRun(runId);
    if (!stored) throw new Error(`Run not found: ${runId}`);
    return stored;
  }

  private async write(runId: string, stored: StoredRun): Promise<void> {
    await putRunObject(`runs/${safeRunId(runId)}.json`, JSON.stringify(stored));
  }
}

let singleton: RunStore | null = null;

export function getRunStore(): RunStore {
  if (singleton) return singleton;

  if (process.env.VERCEL === '1') {
    try {
      getRunObjectStore();
    } catch (error) {
      throw new RunStoreConfigurationError(error instanceof Error ? error.message : String(error));
    }
    singleton = new ObjectRunStore();
    return singleton;
  }

  singleton = new FileRunStore(process.env.RUN_STATE_DIR ?? path.join(process.cwd(), '.detiq-runs'));
  return singleton;
}

export function createRunRecord(args: {
  sourceType: 'user' | 'org';
  sourceName: string;
  adapterNames: string[];
  options: BackupRunRecord['config']['options'];
}): BackupRunRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tenantId: process.env.DETIQ_TENANT_ID ?? 'default',
    status: 'queued',
    profile: args.options.metadata ? 'custom' : 'code',
    sourceType: args.sourceType,
    sourceName: args.sourceName,
    createdAt: now,
    extractorVersion: process.env.NEXT_PUBLIC_EXTRACTOR_VERSION ?? 'web',
    githubApiVersion: process.env.GITHUB_API_VERSION ?? '2022-11-28',
    estimatedRepos: 0,
    discoveredRepos: 0,
    completedRepos: 0,
    partialRepos: 0,
    failedRepos: 0,
    bytesUploaded: 0,
    config: {
      targetType: args.sourceType,
      targetName: args.sourceName,
      adapterNames: args.adapterNames,
      options: args.options,
    },
  };
}

export async function emitRunEvent(
  runId: string,
  type: RunEventType,
  message?: string,
  details: Partial<Omit<RunEvent, 'id' | 'runId' | 'sequence' | 'createdAt' | 'type' | 'message'>> = {}
): Promise<RunEvent> {
  return getRunStore().appendEvent(runId, { type, message, ...details });
}

function safeRunId(runId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid run id');
  return runId;
}

type RedisResponse = { result: unknown };

async function parseRedisResponse(response: Response): Promise<RedisResponse> {
  const payload = await response.json() as unknown;
  if (!response.ok) throw new Error(`Run store request failed (${response.status}).`);
  return parseRedisPayload(payload);
}

function parseRedisPayload(payload: unknown): RedisResponse {
  if (!payload || typeof payload !== 'object' || !('result' in payload)) {
    throw new Error('Run store returned an invalid response.');
  }
  return payload as RedisResponse;
}
