import type * as cf from "@cloudflare/workers-types";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** The shape of {@link WorkerExecutionContext}. */
export interface WorkerExecutionContextService {
  /**
   * Run an Effect in the background without blocking the response, keeping
   * the Worker alive until it settles. The Effect runs with the caller's
   * full context (services, tracing).
   */
  waitUntil<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<void, never, R | RuntimeContext>;
  /**
   * The properties this invocation was called with (`ctx.props`). An empty
   * object for an external request.
   */
  readonly props: Effect.Effect<Record<string, unknown>, never, RuntimeContext>;
  /** The native execution context, for interop with async APIs. */
  readonly raw: cf.ExecutionContext;
}

/**
 * The native `ExecutionContext` of the current Celld Worker event.
 *
 * A `Context.Reference`: yielding it during Worker initialization returns a
 * deferred context whose methods resolve the live per-event context when
 * run inside a handler.
 */
export const WorkerExecutionContext = Context.Reference<WorkerExecutionContextService>(
  "Celld.WorkerExecutionContext",
  { defaultValue: () => deferredExecutionContext },
);
export type WorkerExecutionContext = typeof WorkerExecutionContext;

/** @internal */
export const fromExecutionContext = (ctx: cf.ExecutionContext): WorkerExecutionContextService => ({
  raw: ctx,
  props: Effect.sync(() => (ctx.props as Record<string, unknown> | undefined) ?? {}),
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      yield* Effect.sync(() =>
        ctx.waitUntil(Effect.runPromise(effect.pipe(Effect.provide(context)))),
      );
    }),
});

const liveExecutionContext = Effect.suspend(() =>
  WorkerExecutionContext.pipe(
    Effect.flatMap((live) =>
      live === deferredExecutionContext
        ? Effect.die(new Error("WorkerExecutionContext can only be used inside a request handler"))
        : Effect.succeed(live),
    ),
  ),
);

/** @internal */
export const deferredExecutionContext: WorkerExecutionContextService = {
  get raw(): cf.ExecutionContext {
    throw new Error("WorkerExecutionContext.raw is only available inside a request handler");
  },
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- defers to the live per-event context
    liveExecutionContext.pipe(Effect.flatMap((live) => live.waitUntil(effect))) as Effect.Effect<
      void,
      never,
      R | RuntimeContext
    >,
  get props() {
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- defers to the live per-event context
    return liveExecutionContext.pipe(Effect.flatMap((live) => live.props)) as Effect.Effect<
      Record<string, unknown>,
      never,
      RuntimeContext
    >;
  },
};

/**
 * Run an Effect in the background without blocking the response. Shorthand
 * for `(yield* Celld.WorkerExecutionContext).waitUntil(effect)`.
 */
export const waitUntil = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R | RuntimeContext> =>
  WorkerExecutionContext.pipe(Effect.flatMap((ctx) => ctx.waitUntil(effect)));
