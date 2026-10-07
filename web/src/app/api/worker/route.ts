import crypto from 'crypto';
import { processQueuedRuns } from '@/lib/runs/worker';

export const runtime = 'nodejs';
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const expectedSecrets = [process.env.WORKER_SECRET, process.env.CRON_SECRET]
    .map(normalizeSecret)
    .filter(Boolean);
  const supplied =
    req.headers.get('x-cron-secret') ??
    req.headers.get('x-worker-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  const normalizedSupplied = normalizeSecret(supplied);
  if (!normalizedSupplied || !expectedSecrets.length) return false;
  return expectedSecrets.some((expected) => {
    if (normalizedSupplied.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(normalizedSupplied), Buffer.from(expected));
  });
}

function normalizeSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

async function handleWorkerRequest(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return Response.json(
      {
        error: 'Unauthorized',
        code: 'WORKER_UNAUTHORIZED',
        message: 'Set WORKER_SECRET or CRON_SECRET in Vercel and send it as Bearer, x-worker-secret, or x-cron-secret.',
      },
      { status: 401 }
    );
  }
  try {
    const result = await processQueuedRuns();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  return handleWorkerRequest(req);
}

export async function POST(req: Request) {
  return handleWorkerRequest(req);
}
