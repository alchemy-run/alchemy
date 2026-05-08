import * as Effect from "effect/Effect";

type RateLimitTypeId = "Cloudflare.RateLimit";
const RateLimitTypeId: RateLimitTypeId = "Cloudflare.RateLimit";

export type RateLimitProps = {
  /**
   * Positive integer string that identifies this rate limit namespace within
   * the Cloudflare account. Bindings with the same namespace share counters.
   */
  namespaceId: string;
  /**
   * Simple rate limit configuration.
   */
  simple: {
    /**
     * Number of allowed calls to `limit()` within the period.
     */
    limit: number;
    /**
     * Rate limit window in seconds.
     */
    period: 10 | 60;
  };
};

/**
 * A Cloudflare Workers Rate Limiting binding.
 *
 * Rate limits are configured as Worker bindings. The binding exposes
 * `limit({ key })` at runtime and does not require a separate Cloudflare
 * resource to be provisioned.
 *
 * @resource
 *
 * @section Binding to a Worker
 * @example Basic rate limit
 * ```typescript
 * const RateLimit = yield* Cloudflare.RateLimit("RateLimit", {
 *   namespaceId: "1001",
 *   simple: { limit: 100, period: 60 },
 * });
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   bindings: { RateLimit },
 * });
 * ```
 */
export type RateLimit = {
  Type: RateLimitTypeId;
  name: string;
  namespaceId: string;
  simple: {
    limit: number;
    period: 10 | 60;
  };
};

export const isRateLimit = (value: unknown): value is RateLimit =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as RateLimit).Type === RateLimitTypeId;

export const RateLimit = Effect.fnUntraced(function* (
  name: string,
  props: RateLimitProps,
) {
  return {
    Type: RateLimitTypeId,
    name,
    namespaceId: props.namespaceId,
    simple: props.simple,
  } satisfies RateLimit;
});
