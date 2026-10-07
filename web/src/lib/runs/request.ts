import type { AdapterConfig } from '@/lib/adapters';
import type { ExtractOptions, RunCreatePayload } from './types';

export function parseRunCreatePayload(input: unknown): RunCreatePayload {
  if (!input || typeof input !== 'object') throw new Error('request body must be an object');
  const body = input as Record<string, unknown>;
  const options = parseOptions(body.options);

  if (typeof body.pat !== 'string' || !body.pat.trim()) throw new Error('pat required');
  if (typeof body.targetName !== 'string' || !body.targetName.trim()) throw new Error('targetName required');
  if (body.targetType !== 'user' && body.targetType !== 'org') {
    throw new Error('targetType must be "user" or "org"');
  }

  if (options.matchRegex) {
    try {
      new RegExp(options.matchRegex);
    } catch {
      throw new Error('Invalid matchRegex - not a valid regular expression');
    }
  }

  if (options.maxFileSizeKb !== undefined && options.maxFileSizeKb < 1) {
    throw new Error('maxFileSizeKb must be > 0');
  }

  if (options.visibility && !['all', 'public', 'private'].includes(options.visibility)) {
    throw new Error('visibility must be all | public | private');
  }

  return {
    pat: body.pat,
    targetType: body.targetType,
    targetName: body.targetName.trim(),
    adapters: parseAdapterConfig(body.adapters),
    options,
  };
}

export function adapterNamesFromConfig(adapters: AdapterConfig): string[] {
  return [
    adapters.r2 ? 'r2' : null,
    adapters.s3 ? 's3' : null,
    adapters.gdrive ? 'gdrive' : null,
    adapters.githubTarget ? 'github-target' : null,
    adapters.azure ? 'azure' : null,
  ].filter((value): value is string => Boolean(value));
}

function parseOptions(input: unknown): ExtractOptions {
  if (!input || typeof input !== 'object') return {};
  const source = input as Record<string, unknown>;

  return {
    skipForks: asBoolean(source.skipForks),
    skipArchived: asBoolean(source.skipArchived),
    dryRun: asBoolean(source.dryRun),
    visibility: source.visibility === 'public' || source.visibility === 'private' || source.visibility === 'all'
      ? source.visibility
      : undefined,
    matchRegex: asString(source.matchRegex),
    topics: asStringArray(source.topics),
    maxFileSizeKb: asPositiveNumber(source.maxFileSizeKb),
    repoConcurrency: asPositiveNumber(source.repoConcurrency),
    fileConcurrency: asPositiveNumber(source.fileConcurrency),
    useDefaultExcludes: asBoolean(source.useDefaultExcludes),
    extraExcludes: asStringArray(source.extraExcludes),
    metadata: asBoolean(source.metadata),
    metadataTypes: asString(source.metadataTypes),
    selectedRepositories: asStringArray(source.selectedRepositories),
    branchOverrides: asStringRecord(source.branchOverrides),
  };
}

function parseAdapterConfig(input: unknown): AdapterConfig {
  if (!input || typeof input !== 'object') return {};
  return input as AdapterConfig;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length ? strings.map((item) => item.trim()) : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string' && Boolean(entry[1].trim())
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}
