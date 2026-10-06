import { getRunStore } from '@/lib/runs/store';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const stored = await getRunStore().getRun(runId);
  if (!stored) return Response.json({ error: 'Run not found' }, { status: 404 });
  return Response.json(stored);
}
