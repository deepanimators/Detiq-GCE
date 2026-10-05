const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getRateLimitResetMs(err: unknown): number | null {
  const headers = (err as any)?.response?.headers;
  if (!headers) return null;
  const reset = headers['x-ratelimit-reset'] ?? headers['retry-after'];
  if (!reset) return null;
  const resetTs = parseInt(reset, 10);
  const isUnix = resetTs > 1_000_000_000;
  const waitMs = isUnix ? resetTs * 1000 - Date.now() + 2000 : resetTs * 1000;
  return Math.max(waitMs, 1000);
}

function isRateLimited(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  return status === 429 || status === 403;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number; label?: string; log?: (msg: string) => void } = {}
): Promise<T> {
  const { maxAttempts = 4, baseDelayMs = 1000, label = 'request', log = console.warn } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;

      let delayMs: number;
      if (isRateLimited(err)) {
        const resetMs = getRateLimitResetMs(err);
        delayMs = resetMs ?? 60_000;
        log(`[rate-limit] ${label} — waiting ${Math.ceil(delayMs / 1000)}s`);
      } else {
        delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        log(`[retry] ${label} attempt ${attempt}/${maxAttempts}`);
      }

      await sleep(delayMs);
    }
  }
  throw new Error('unreachable');
}
