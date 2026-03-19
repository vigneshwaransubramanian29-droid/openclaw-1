export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= options.maxAttempts) {
        break;
      }
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) {
        break;
      }
      const delayMs = options.baseDelayMs * attempt;
      await sleep(delayMs);
    }
  }
  throw lastError;
}
