/**
 * Rate limiting binding for Cloudflare Workers.
 *
 * The RateLimit binding provides access to Cloudflare's rate limiting functionality,
 * allowing you to implement rate limiting directly in your Workers without needing
 * to rely on external services.
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
 */
export function RateLimit(options: {
  namespace_id: number;
  simple: {
    limit: number;
    period: number;
  };
}): RateLimit {
  return {
    type: "rate_limit",
    namespace_id: options.namespace_id,
    simple: options.simple,
  };
}

export type RateLimit = {
  type: "rate_limit";
  namespace_id: number;
  simple: {
    limit: number;
    period: number;
  };
};
