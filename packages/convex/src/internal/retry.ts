import * as Retry from "@distilled.cloud/convex/Retry";
import { isThrottling } from "@distilled.cloud/core/category";
import type * as Effect from "effect/Effect";

/**
 * The retry policy for a Convex create. Convex answers a repeated create by
 * making a second project, renaming a key or replacing a preview, so a create
 * that got a 5xx must not repeat. Only throttling is safe to retry.
 */
export const createPolicy = {
  while: (error: unknown) => isThrottling(error),
  backoff: { baseMs: 1000, factor: 2, capMs: 5000, maxRetries: 6, jitterMs: 50 },
};

/** Run a create that retries on throttling only. */
export const createOnce = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(Retry.policy(createPolicy));
