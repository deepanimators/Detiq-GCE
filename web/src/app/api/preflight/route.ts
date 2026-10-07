import { runPreflight } from '@/lib/preflight';
import { parseRunCreatePayload } from '@/lib/runs/request';
import { formatGitHubError, getGitHubErrorDetails } from '@/lib/github';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const payload = parseRunCreatePayload(await req.json());
    const result = await runPreflight(payload);
    return Response.json({
      ok: result.ok,
      source: result.source,
      adapters: result.adapters,
      warnings: result.warnings,
    }, { status: result.ok ? 200 : 422 });
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
