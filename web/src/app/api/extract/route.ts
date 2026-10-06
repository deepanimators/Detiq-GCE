import { buildAdaptersFromConfig } from '@/lib/adapters';
import { runExtraction } from '@/lib/extractor';

export const maxDuration = 300;

type ExtractOptions = {
  skipForks?: boolean;
  skipArchived?: boolean;
  dryRun?: boolean;
  visibility?: 'all' | 'public' | 'private';
  matchRegex?: string;
  topics?: string[];
  maxFileSizeKb?: number;
  repoConcurrency?: number;
  fileConcurrency?: number;
  useDefaultExcludes?: boolean;
  extraExcludes?: string[];
  metadata?: boolean;
  metadataTypes?: string;
};

export async function POST(req: Request) {
  const body = await req.json();
  const { pat, targetType, targetName, adapters: adapterConfig, options = {} as ExtractOptions } = body;

  // Input validation
  if (!pat || typeof pat !== 'string') return Response.json({ error: 'pat required' }, { status: 400 });
  if (!targetName || typeof targetName !== 'string') return Response.json({ error: 'targetName required' }, { status: 400 });
  if (!['user', 'org'].includes(targetType)) return Response.json({ error: 'targetType must be "user" or "org"' }, { status: 400 });

  if (options.matchRegex) {
    try { new RegExp(options.matchRegex); }
    catch { return Response.json({ error: 'Invalid matchRegex — not a valid regular expression' }, { status: 400 }); }
  }
  if (options.maxFileSizeKb !== undefined && options.maxFileSizeKb < 1) {
    return Response.json({ error: 'maxFileSizeKb must be > 0' }, { status: 400 });
  }
  if (options.visibility && !['all', 'public', 'private'].includes(options.visibility)) {
    return Response.json({ error: 'visibility must be all | public | private' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { /* client disconnected */ }
      };

      try {
        const adapters = buildAdaptersFromConfig(adapterConfig ?? {});
        if (!adapters.length && !options.dryRun) {
          send({ error: 'No storage adapters configured' });
          controller.close();
          return;
        }

        const summary = await runExtraction({
          pat,
          targetType: targetType as 'user' | 'org',
          targetName,
          adapters,
          skipForks: options.skipForks,
          skipArchived: options.skipArchived,
          visibility: options.visibility,
          matchRegex: options.matchRegex,
          topics: options.topics,
          dryRun: options.dryRun,
          useDefaultExcludes: options.useDefaultExcludes,
          extraExcludes: options.extraExcludes,
          maxFileSizeKb: options.maxFileSizeKb,
          repoConcurrency: options.repoConcurrency,
          fileConcurrency: options.fileConcurrency,
          metadata: options.metadata,
          metadataTypes: options.metadataTypes,
          onLog: (msg: string) => send({ msg }),
        });

        send({ done: true, summary });
      } catch (e) {
        // Never echo PAT in error messages
        const msg = String(e).replace(pat, '[PAT]');
        send({ error: msg });
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
