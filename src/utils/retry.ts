/**
 * Utility for exponential backoff retry on transient network, 5xx server,
 * or 429 rate-limit errors.
 */

export interface RetryOptions {
  retries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  operationName?: string;
  shouldRetry?: (error: any) => boolean;
}

/**
 * Executes an asynchronous operation with exponential backoff and randomized jitter.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    initialDelayMs = 2000,
    backoffFactor = 2,
    operationName = 'Async Operation',
    shouldRetry = () => true
  } = options;

  let lastError: any;
  const maxAttempts = 1 + retries;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;

      // Check if we should retry this specific error
      if (!shouldRetry(err) || attempt === maxAttempts) {
        break;
      }

      // Calculate exponential delay with randomized jitter (+/- 20%)
      const baseDelay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
      const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
      const delayMs = Math.max(10, Math.round(baseDelay + jitter));

      console.warn(
        `[WARN] [RETRY] ${operationName} failed (Attempt ${attempt}/${maxAttempts}): ${err?.message || 'Unknown error'}. Retrying in ${delayMs}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
