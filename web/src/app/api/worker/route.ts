import crypto from 'crypto';
import { processNextQueuedRun } from '@/lib/runs/worker';

export const runtime = 'nodejs';
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const supplied =
    req.headers.get('x-cron-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (!expected || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function process(req: Request): Promise<Response> {
  if (!authorized(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const processed = await processNextQueuedRun();
    return Response.json({ ok: true, processed });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  return process(req);
}

export async function POST(req: Request) {
  return process(req);
}
