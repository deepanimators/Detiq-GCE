import { buildAdaptersFromConfig } from '@/lib/adapters';
import { runExtraction } from '@/lib/extractor';

export const maxDuration = 300;

export async function POST(req: Request) {
  const body = await req.json();
  const { pat, targetType, targetName, adapters: adapterConfig, options = {} } = body;

  if (!pat) return Response.json({ error: 'pat required' }, { status: 400 });
  if (!targetName) return Response.json({ error: 'targetName required' }, { status: 400 });
  if (!targetType) return Response.json({ error: 'targetType required' }, { status: 400 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // client disconnected
        }
      };

      try {
        const adapters = buildAdaptersFromConfig(adapterConfig ?? {});
        if (!adapters.length && !options.dryRun) {
          send({ error: 'No storage adapters configured' });
          controller.close();
          return;
        }

        send({ msg: `Starting extraction: ${targetType}/${targetName}` });

        const summary = await runExtraction({
          pat,
          targetType,
          targetName,
          adapters,
          skipForks: options.skipForks,
          skipArchived: options.skipArchived,
          visibility: options.visibility,
          matchRegex: options.matchRegex,
          topics: options.topics,
          dryRun: options.dryRun,
          maxFileSizeKb: options.maxFileSizeKb,
          repoConcurrency: options.repoConcurrency,
          fileConcurrency: options.fileConcurrency,
          onLog: (msg: string) => send({ msg }),
        });

        send({ done: true, summary });
      } catch (e) {
        send({ error: String(e) });
      }

      controller.close();
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
