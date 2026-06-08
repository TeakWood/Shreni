export const AGENT_RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelayMs: 5_000,
  backoffMultiplier: 2,
  maxDelayMs: 60_000,
  retryableStatuses: [429, 502, 503, 529],
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'],
};

export type RetryConfig = typeof AGENT_RETRY_CONFIG;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(err: unknown, config: RetryConfig): boolean {
  const e = err as { status?: number; message?: string; code?: string };
  if (e.status !== undefined && config.retryableStatuses.includes(e.status)) return true;
  const msg = e.message ?? e.code ?? '';
  return config.retryableErrors.some(code => msg.includes(code));
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  config: RetryConfig = AGENT_RETRY_CONFIG,
): Promise<T> {
  let attempt = 0;
  let delay = config.initialDelayMs;

  while (attempt < config.maxAttempts) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err, config) || attempt >= config.maxAttempts) throw err;

      console.warn(
        `[retry] ${label} attempt ${attempt} failed (${(err as Error).message}). Retry in ${delay}ms`,
      );
      await sleep(delay);
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }
  // Unreachable — the while loop always throws before exhausting, but TS needs this
  throw new Error(`${label} exhausted ${config.maxAttempts} attempts`);
}