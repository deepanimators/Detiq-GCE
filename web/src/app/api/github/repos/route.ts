import { formatGitHubError, getGitHubErrorDetails, GitHubClient, type ListRepoOptions } from '@/lib/github';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const pat = typeof body.pat === 'string' ? body.pat.trim() : '';
    const targetName = typeof body.targetName === 'string' ? body.targetName.trim() : '';
    const targetType = body.targetType === 'user' || body.targetType === 'org' ? body.targetType : null;
    if (!pat || !targetName || !targetType) {
      return Response.json({ error: 'pat, targetType, and targetName are required' }, { status: 400 });
    }

    const options: ListRepoOptions = {
      visibility: body.visibility === 'public' || body.visibility === 'private' ? body.visibility : 'all',
      skipForks: body.skipForks === true,
      skipArchived: body.skipArchived === true,
      matchRegex: typeof body.matchRegex === 'string' && body.matchRegex.length > 0 ? body.matchRegex : undefined,
      topics: Array.isArray(body.topics)
        ? body.topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0).map((topic) => topic.trim())
        : undefined,
    };
    const client = new GitHubClient(pat);
    const repos = targetType === 'user'
      ? await client.listUserRepos(targetName, options)
      : await client.listOrgRepos(targetName, options);
    return Response.json({ repositories: repos });
  } catch (error) {
    const details = getGitHubErrorDetails(error);
    return Response.json(
      {
        error: formatGitHubError(error),
        code: details.status === 401 ? 'GITHUB_UNAUTHORIZED' : details.status === 403 ? 'GITHUB_FORBIDDEN' : 'GITHUB_REQUEST_FAILED',
        status: details.status,
        hint: details.status === 403
          ? 'For organization repositories, authorize the token for org SSO, grant private repository access, check fine-grained token repository selection, and wait for any rate-limit reset.'
          : undefined,
        rateLimitResetAt: details.rateLimitReset ? new Date(details.rateLimitReset * 1000).toISOString() : undefined,
        documentationUrl: details.documentationUrl,
      },
      { status: details.status && details.status >= 400 && details.status < 500 ? details.status : 502 }
    );
  }
}
