/// <reference types="@cloudflare/workers-types" />

import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "./Worker.ts";
import {
  RateLimit,
  type RateLimitMarker as RateLimitLike,
} from "./RateLimit.ts";

/**
 * Native runtime layer for the Rate Limit binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Workers.RateLimitBinding)`)
 * so that yielding a {@link RateLimitLike} marker attaches the `ratelimit`
 * binding to the surrounding Worker and returns the runtime
 * {@link RateLimitClient}.
 *
 * @example Bind a RateLimit inside an Effect-native Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const throttle = yield* Cloudflare.RateLimit({
 *     namespaceId: 1001,
 *     simple: { limit: 10, period: 60 },
 *   });
 *   // ...
 * }).pipe(Effect.provide(Cloudflare.Workers.RateLimitBinding))
 * ```
 */
export const RateLimitBinding = Layer.effect(
  RateLimit,
  Effect.gen(function* () {
    const host = yield* Worker;

    return Effect.fn(function* (rateLimit: RateLimitLike) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind(rateLimit.name, {
          bindings: [
            {
              type: "ratelimit",
              name: rateLimit.name,
              namespaceId: rateLimit.namespaceId,
              simple: rateLimit.simple,
            } as any,
          ],
        });
      }
      const raw = WorkerEnvironment.useSync(
        (env) => (env as Record<string, cf.RateLimit>)[rateLimit.name]!,
      );
      return {
        raw,
        limit: (options) =>
          raw.pipe(
            Effect.flatMap((binding) =>
              Effect.tryPromise({
                try: () => binding.limit(options),
                catch: (error) =>
                  new RateLimitError({
                    message:
                      error instanceof Error
                        ? error.message
                        : "Unknown RateLimit error",
                    cause: error,
                  }),
              }),
            ),
          ),
      } satisfies RateLimitClient;
    });
  }),
);

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  message: string;
  cause: unknown;
}> {}

export interface RateLimitClient {
  raw: Effect.Effect<cf.RateLimit, never, WorkerEnvironment>;
  limit(
    options: Parameters<cf.RateLimit["limit"]>[0],
  ): Effect.Effect<
    Awaited<ReturnType<cf.RateLimit["limit"]>>,
    RateLimitError,
    WorkerEnvironment
  >;
}
