import crypto from 'crypto';
import { buildAdaptersFromEnv } from '@/lib/adapters';
import { runExtraction } from '@/lib/extractor';

export const maxDuration = 300;

function timingSafeEqual(a: string, b: string): boolean {
  // Must be same length for timingSafeEqual; pad shorter to prevent length leak
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a comparison to avoid short-circuit timing, then return false
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function POST(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });

  const secret =
    req.headers.get('x-cron-secret') ??
    req.headers.get('authorization')?.replace('Bearer ', '') ??
    '';

  if (!timingSafeEqual(secret, expected)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await readJsonBody(req);
  const pat = typeof body.pat === 'string' && body.pat.trim() ? body.pat : process.env.GITHUB_PAT;
  const targetType = body.targetType === 'user' || body.targetType === 'org'
    ? body.targetType
    : undefined;
  const targetName = typeof body.targetName === 'string' ? body.targetName.trim() : '';

  if (!pat) return Response.json({ error: 'GITHUB_PAT not set' }, { status: 500 });
  if (!targetType || !targetName) {
    return Response.json(
      { error: 'targetType and targetName are required in the request body' },
      { status: 400 }
    );
  }

  const adapters = buildAdaptersFromEnv();
  if (!adapters.length && process.env.CRON_DRY_RUN !== 'true') {
    return Response.json({ error: 'No storage adapters configured in env' }, { status: 500 });
  }

  async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
    try {
      const body = await req.json();
      return body && typeof body === 'object' ? body as Record<string, unknown> : {};
    } catch {
      return {};
    }
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
      matchRegex: process.env.CRON_MATCH,
      topics: process.env.CRON_TOPICS?.split(',').map((t) => t.trim()).filter(Boolean),
      maxFileSizeKb: process.env.CRON_MAX_FILE_SIZE ? parseInt(process.env.CRON_MAX_FILE_SIZE) : undefined,
      repoConcurrency: process.env.CRON_REPO_CONCURRENCY ? parseInt(process.env.CRON_REPO_CONCURRENCY) : undefined,
      fileConcurrency: process.env.CRON_FILE_CONCURRENCY ? parseInt(process.env.CRON_FILE_CONCURRENCY) : undefined,
      metadata: process.env.CRON_METADATA === 'true',
      metadataTypes: process.env.CRON_METADATA_TYPES,
      onLog: (msg: string) => logs.push(msg),
    });

    return Response.json({ ok: true, summary, logs });
  } catch (e) {
    return Response.json({ ok: false, error: String(e), logs }, { status: 500 });
  }
}

// Health check — no config info exposed
export async function GET() {
  return Response.json({ status: 'ok' });
}
