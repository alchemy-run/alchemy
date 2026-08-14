/**
 * Leaf module holding the Worker runtime-environment surface the
 * `alchemy/Serve` bridge (and the Worker runtime bridges) build on:
 * {@link WorkerEnvironment}, {@link WorkerExecutionContext} (+ the
 * deferred/live per-event context machinery), and the {@link WorkerEvent}
 * envelope.
 *
 * Extracted from `Worker.ts` (which re-exports everything here, so the
 * public surface is unchanged) so that foreign bundlers compiling a serve
 * mount (`alchemy/Next` inside a Next.js app, `alchemy/Nitro`
 * inside nitro, …) never traverse `Worker.ts`'s provider import graph —
 * that graph reaches the local-runtime chain
 * (`WorkerAsyncBindings` → `KV/Namespace` → `LocalRuntime` →
 * `@alchemy.run/cloudflare-runtime` → the workerd native binary), which
 * turbopack/webpack cannot parse. Keep this module free of imports beyond
 * `effect`, type-only `@cloudflare/workers-types`, and the engine's
 * `RuntimeContext` type.
 */

import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";

export class WorkerEnvironment extends Context.Service<
  WorkerEnvironment,
  Record<string, any>
>()("Cloudflare.Workers.WorkerEnvironment") {}

export class CachePurgeError extends Data.TaggedError("CachePurgeError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Effect-native view of the Workers Cache runtime API on the execution
 * context (`ctx.cache`). Only available when the Worker has Workers Cache
 * enabled (the `cache` prop or `yield* Cloudflare.cache()`).
 */
export interface WorkerExecutionContextCache {
  /**
   * Purge cached responses by `Cache-Tag`, path prefix, or everything.
   */
  purge(
    options: cf.CachePurgeOptions,
  ): Effect.Effect<cf.CachePurgeResult, CachePurgeError, RuntimeContext>;
}

export class WorkerExecutionContext extends Context.Service<
  WorkerExecutionContext,
  {
    /**
     * Run an Effect in the background without blocking the response, keeping
     * the Worker alive until it settles. The Effect runs with the caller's
     * full context (services, tracing), and the resulting promise is
     * registered with workerd's `ctx.waitUntil`.
     */
    waitUntil<A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<void, never, R | RuntimeContext>;
    /**
     * Forward the request to the origin if the Worker throws an unhandled
     * exception, instead of returning an error page.
     */
    passThroughOnException(): Effect.Effect<void, never, RuntimeContext>;
    /**
     * The Workers Cache runtime API (`ctx.cache`).
     */
    readonly cache: WorkerExecutionContextCache;
    /**
     * The raw workerd ExecutionContext, for interop with async APIs.
     */
    readonly raw: cf.ExecutionContext;
  }
>()("Cloudflare.Workers.WorkerExecutionContext") {}

export const fromExecutionContext = (
  ctx: cf.ExecutionContext,
): WorkerExecutionContext["Service"] => ({
  raw: ctx,
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      // Register the promise with workerd un-awaited — waitUntil extends the
      // invocation's lifetime without blocking the response.
      yield* Effect.sync(() =>
        ctx.waitUntil(Effect.runPromise(effect.pipe(Effect.provide(context)))),
      );
    }),
  passThroughOnException: () => Effect.sync(() => ctx.passThroughOnException()),
  cache: {
    purge: (options) =>
      ctx.cache
        ? Effect.tryPromise({
            try: () => ctx.cache!.purge(options),
            catch: (cause) =>
              new CachePurgeError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Unknown cache purge error",
                cause,
              }),
          })
        : Effect.fail(
            new CachePurgeError({
              message:
                "ctx.cache is not available — enable Workers Cache on this " +
                "Worker (the `cache` prop or `yield* Cloudflare.cache()`) " +
                "and note it is not supported in local dev.",
            }),
          ),
  },
});

/**
 * A {@link WorkerExecutionContext} whose methods resolve the live per-event
 * context from the calling fiber at call time. Provided during the Worker's
 * init phase (plan and runtime module init) so the service can be yielded
 * and closed over in the top-level closure; every method is colored with
 * `RuntimeContext`, so it can only be *run* inside a handler, where the
 * bridge provides the real per-event context that these methods defer to.
 */
export const deferredExecutionContext: WorkerExecutionContext["Service"] = {
  get raw(): cf.ExecutionContext {
    throw new Error(
      "WorkerExecutionContext.raw is only available inside a request handler",
    );
  },
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    liveExecutionContext.pipe(
      Effect.flatMap((live) => live.waitUntil(effect)),
    ) as Effect.Effect<void, never, R | RuntimeContext>,
  passThroughOnException: () =>
    liveExecutionContext.pipe(
      Effect.flatMap((live) => live.passThroughOnException()),
    ) as Effect.Effect<void, never, RuntimeContext>,
  cache: {
    purge: (options) =>
      liveExecutionContext.pipe(
        Effect.flatMap((live) => live.cache.purge(options)),
      ) as Effect.Effect<cf.CachePurgeResult, CachePurgeError, RuntimeContext>,
  },
};

const liveExecutionContext = WorkerExecutionContext.pipe(
  Effect.flatMap((live) =>
    live === deferredExecutionContext
      ? Effect.die(
          new Error(
            "WorkerExecutionContext can only be used inside a request handler",
          ),
        )
      : Effect.succeed(live),
  ),
);

export type WorkerEvent = Exclude<
  {
    [type in keyof cf.ExportedHandler]: {
      kind: "Cloudflare.Workers.WorkerEvent";
      type: type;
      input: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[0];
      env: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[1];
      context: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[2];
    };
  }[keyof cf.ExportedHandler],
  undefined
>;

export const isWorkerEvent = (value: any): value is WorkerEvent =>
  value?.kind === "Cloudflare.Workers.WorkerEvent";
