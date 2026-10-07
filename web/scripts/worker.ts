import "dotenv/config";

import { processQueuedRuns } from '../src/lib/runs/worker';

async function main() {
  console.log('Starting standalone worker process...');
  while (true) {
    try {
      const result = await processQueuedRuns({
        maxJobs: parseInt(process.env.WORKER_BATCH_SIZE ?? '1'),
        maxRuntimeMs: 3600000 // 1 hour max per iteration to avoid leaks
      });
      if (result.exhausted) {
        // Queue empty, wait a bit
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {
      console.error('Worker error:', e);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch(console.error);
