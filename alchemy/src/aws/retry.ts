import { withExponentialBackoff } from "../util/retry.ts";

/**
 * Check if an error is retryable (throttling/rate limiting)
 */
function isRetryableError(error: any): boolean {
  if (!error) return false;

  const errorCode = error.name || error.code || "";
  const errorMessage = error.message || "";

  // Check for common AWS throttling error codes and messages
  return (
    errorCode === "Throttling" ||
    errorCode === "ThrottlingException" ||
    errorCode === "TooManyRequestsException" ||
    errorCode === "RequestLimitExceeded" ||
    errorMessage.includes("Rate exceeded") ||
    errorMessage.includes("throttling") ||
    errorMessage.includes("Throttling") ||
    errorMessage.includes("Internal server error")
  );
}

/**
 * Retry function with standardized parameters for AWS throttling
 */
export function retry<T>(
  operation: () => Promise<T>,
  extraIsRetryableError?: (error: any) => boolean,
): Promise<T> {
  return withExponentialBackoff(
    operation,
    (err) => isRetryableError(err) || extraIsRetryableError?.(err) || false,
    10, // max attempts
    1000, // initial delay ms
  );
}
