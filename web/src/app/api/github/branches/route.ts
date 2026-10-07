import { formatGitHubError, getGitHubErrorDetails, GitHubClient } from '@/lib/github';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const pat = typeof body.pat === 'string' ? body.pat.trim() : '';
    const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
    const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
    if (!pat || !owner || !repo) {
      return Response.json({ error: 'pat, owner, and repo are required' }, { status: 400 });
    }
    const branches = await new GitHubClient(pat).listBranches(owner, repo);
    return Response.json({ branches });
  } catch (error) {
    const details = getGitHubErrorDetails(error);
    return Response.json(
      {
        error: formatGitHubError(error),
        code: details.status === 401 ? 'GITHUB_UNAUTHORIZED' : details.status === 403 ? 'GITHUB_FORBIDDEN' : 'GITHUB_REQUEST_FAILED',
        status: details.status,
        documentationUrl: details.documentationUrl,
      },
      { status: details.status && details.status >= 400 && details.status < 500 ? details.status : 502 }
    );
  }
}
