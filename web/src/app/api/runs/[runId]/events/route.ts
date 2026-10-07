import { getRunStore } from '@/lib/runs/store';

export const runtime = 'nodejs';

const TERMINAL_STATUSES = new Set(['preflight_failed', 'completed', 'partial', 'failed', 'cancelled']);
const POLL_INTERVAL_MS = 1000;
const STREAM_TTL_MS = 25_000;

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
      let closed = false;
      const send = (data: object) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      controller.enqueue(encoder.encode('retry: 2000\n\n'));

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearTimeout(ttl);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      const timer = setInterval(async () => {
        try {
          const stored = await store.getRun(runId);
          if (!stored) {
            send({ error: 'Run not found' });
            close();
            return;
          }

          const events = stored.events.filter((event) => event.sequence > cursor);
          for (const event of events) {
            cursor = event.sequence;
            send({ event, run: stored.run });
          }

          if (TERMINAL_STATUSES.has(stored.run.status)) {
            close();
          }
        } catch (error) {
          send({ error: error instanceof Error ? error.message : String(error) });
          close();
        }
      }, POLL_INTERVAL_MS);

      const ttl = setTimeout(() => {
        send({ reconnect: true, after: cursor });
        close();
      }, STREAM_TTL_MS);

      req.signal.addEventListener('abort', () => {
        close();
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
