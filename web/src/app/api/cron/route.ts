import { buildAdaptersFromEnv } from '@/lib/adapters';
import { runExtraction } from '@/lib/extractor';

export const maxDuration = 300;

export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (secret !== expected) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pat = process.env.GITHUB_PAT;
  const targetType = (process.env.CRON_TARGET_TYPE ?? 'org') as 'user' | 'org';
  const targetName = process.env.CRON_TARGET_NAME;

  if (!pat) return Response.json({ error: 'GITHUB_PAT not set' }, { status: 500 });
  if (!targetName) return Response.json({ error: 'CRON_TARGET_NAME not set' }, { status: 500 });

  const adapters = buildAdaptersFromEnv();
  if (!adapters.length) {
    return Response.json({ error: 'No storage adapters configured in env' }, { status: 500 });
  }

  const logs: string[] = [];

  try {
    const summary = await runExtraction({
      pat,
      targetType,
      targetName,
      adapters,
      skipForks: process.env.CRON_SKIP_FORKS === 'true',
      skipArchived: process.env.CRON_SKIP_ARCHIVED === 'true',
      visibility: (process.env.CRON_VISIBILITY as 'all' | 'public' | 'private') ?? 'all',
      dryRun: process.env.CRON_DRY_RUN === 'true',
      onLog: (msg: string) => logs.push(msg),
    });

    return Response.json({ ok: true, summary, logs });
  } catch (e) {
    return Response.json({ ok: false, error: String(e), logs }, { status: 500 });
  }
}

// Allow GET for quick health check from cronjobs.org
export async function GET() {
  return Response.json({ status: 'ok', configured: !!process.env.CRON_SECRET });
}
