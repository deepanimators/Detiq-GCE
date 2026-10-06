import { getRunStore } from '@/lib/runs/store';

export const runtime = 'nodejs';

const TERMINAL_STATUSES = new Set(['preflight_failed', 'completed', 'partial', 'failed', 'cancelled']);

export async function GET(
  req: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const store = getRunStore();
  const existing = await store.getRun(runId);
  if (!existing) return Response.json({ error: 'Run not found' }, { status: 404 });

  const url = new URL(req.url);
  let cursor = Number(url.searchParams.get('after') ?? '0');
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const timer = setInterval(async () => {
        try {
          const stored = await store.getRun(runId);
          if (!stored) {
            send({ error: 'Run not found' });
            clearInterval(timer);
            controller.close();
            return;
          }

          const events = stored.events.filter((event) => event.sequence > cursor);
          for (const event of events) {
            cursor = event.sequence;
            send({ event, run: stored.run });
          }

          if (TERMINAL_STATUSES.has(stored.run.status)) {
            clearInterval(timer);
            controller.close();
          }
        } catch (error) {
          send({ error: error instanceof Error ? error.message : String(error) });
          clearInterval(timer);
          controller.close();
        }
      }, 1000);

      req.signal.addEventListener('abort', () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
