import { runPreflight } from '@/lib/preflight';
import { parseRunCreatePayload } from '@/lib/runs/request';

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
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }
}
