import { buildAdaptersFromConfig } from '@/lib/adapters';
import { isDurableStorageAdapter, preflightFailure, type StoragePreflightResult } from '@/lib/adapters/base';
import { GitHubClient, type ListRepoOptions, type Repo } from '@/lib/github';
import type { RunCreatePayload } from './runs/types';

export type SourcePreflightResult = {
  ok: boolean;
  targetType: 'user' | 'org';
  targetName: string;
  repositoryCount: number;
  warning?: string;
  message?: string;
  errorCode?: string;
};

export type PreflightResult = {
  ok: boolean;
  source: SourcePreflightResult;
  adapters: StoragePreflightResult[];
  repositories: Repo[];
  warnings: string[];
};

const LARGE_RUN_WARNING_REPO_COUNT = 500;

export async function runPreflight(payload: RunCreatePayload): Promise<PreflightResult> {
  const client = new GitHubClient(payload.pat);
  const listOpts: ListRepoOptions = {
    skipForks: payload.options.skipForks,
    skipArchived: payload.options.skipArchived,
    visibility: payload.options.visibility ?? 'all',
    matchRegex: payload.options.matchRegex,
    topics: payload.options.topics,
  };

  const repositories = payload.targetType === 'user'
    ? await client.listUserRepos(payload.targetName, listOpts)
    : await client.listOrgRepos(payload.targetName, listOpts);
  const selected = payload.options.selectedRepositories;
  const selectedSet = selected?.length ? new Set(selected) : null;
  const filteredRepositories = selectedSet
    ? repositories.filter((repo) => selectedSet.has(repo.name))
    : repositories;
  for (const repo of filteredRepositories) {
    const override = payload.options.branchOverrides?.[repo.name];
    if (override) repo.defaultBranch = override;
  }

  const source: SourcePreflightResult = {
    ok: true,
    targetType: payload.targetType,
    targetName: payload.targetName,
    repositoryCount: filteredRepositories.length,
    message: `Found ${filteredRepositories.length} matching repositories.`,
  };

  const adapters = buildAdaptersFromConfig(payload.adapters);
  const adapterResults = payload.options.dryRun
    ? []
    : await Promise.all(adapters.map(async (adapter) => {
        if (!isDurableStorageAdapter(adapter)) {
          const adapterName = (adapter as { name?: string }).name ?? 'unknown';
          return preflightFailure(adapterName, new Error(`${adapterName} does not implement durable preflight`));
        }
        return adapter.preflight();
      }));

  const warnings: string[] = [];
  if (filteredRepositories.length >= LARGE_RUN_WARNING_REPO_COUNT) {
    warnings.push(
      `Large run warning: ${repositories.length} repositories should run as asynchronous worker jobs, not a single request.`
    );
  }
  if (!payload.options.dryRun && !adapters.length) {
    warnings.push('No storage adapters configured.');
  }

  const adapterFailures = adapterResults.filter((result) => !result.writable);
  const ok = source.ok && adapterFailures.length === 0 && (payload.options.dryRun || adapters.length > 0);

  return {
    ok,
    source,
    adapters: adapterResults,
    repositories: filteredRepositories,
    warnings,
  };
}
