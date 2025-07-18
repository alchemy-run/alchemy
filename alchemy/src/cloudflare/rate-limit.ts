/**
 * Rate limiting binding for Cloudflare Workers.
 *
 * The RateLimit binding provides access to Cloudflare's rate limiting functionality,
 * allowing you to implement rate limiting directly in your Workers without needing
 * to rely on external services.
 * @param options Configuration options for the rate limit binding.
 * @param options.namespace_id A positive integer that uniquely defines this rate limiting configuration (e.g., namespace_id = 999).
 * @param options.simple.limit The limit (number of requests or API calls) to be applied. This is incremented when you call the limit() function in your Worker.
 * @param options.simple.period The period, in seconds, to measure increments to the limit over. Must be either 10 or 60.
 *
 * @example
 * ```ts
 * import { Worker, RateLimit } from "alchemy/cloudflare";
 *
 * const rateLimit = RateLimit({
 *   namespace_id: 1001,
 *   simple: {
 *     limit: 1500,
 *     period: 60
 *   }
 * });
 *
 * await Worker("my-worker", {
 *   name: "my-worker",
 *   entrypoint: "./src/worker.ts",
 *   bindings: {
 *     MY_RATE_LIMIT: rateLimit
 *   }
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 *
 * @returns A RateLimit binding object.
 */
export function RateLimit(options: {
  namespace_id: number;
  simple: {
    limit: number;
    period: 60 | 10;
  };
}): RateLimit {
  return {
    type: "ratelimit",
    namespace_id: options.namespace_id,
    simple: options.simple,
  };
}

export type RateLimit = {
  type: "ratelimit";
  namespace_id: number;
  simple: {
    limit: number;
    period: 60 | 10;
  };
};
