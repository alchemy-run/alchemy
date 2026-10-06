import { Retry } from "@distilled.cloud/prisma";
import * as Schedule from "effect/Schedule";

/**
 * Retry policy for non-idempotent Management API writes (creates, forks).
 *
 * The default policy retries every transient error, and a replayed create
 * after a 5xx or a dropped connection can make a second resource. A 429 is
 * rejected before Prisma processes the request, so throttling is the one
 * failure that is always safe to retry. The workspace limit is 30 requests
 * per minute, so honor the server's retry hint, bounded to 8 attempts.
 */
export const retryThrottlingOnly = Retry.policy((lastError) => {
  const throttling = Retry.throttlingFactory(lastError);
  return {
    while: throttling.while,
    schedule: Schedule.max([throttling.schedule!, Schedule.recurs(8)]),
  };
});
