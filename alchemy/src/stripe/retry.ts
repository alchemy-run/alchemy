import { withExponentialBackoff } from "../util/retry.ts";

/**
 * Determines if a Stripe error should trigger a retry
 */
function isStripeRetryableError(error: any): boolean {
  return (
    error?.status === 429 ||
    error?.code === "lock_timeout" ||
    error?.type === "rate_limit_error"
  );
}

/**
 * Wraps a Stripe API operation with retry logic for rate limiting
 */
export async function withStripeRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 5,
  initialDelayMs = 1000,
): Promise<T> {
  return withExponentialBackoff(
    operation,
    isStripeRetryableError,
    maxAttempts,
    initialDelayMs,
  );
}
