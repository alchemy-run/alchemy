import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * The current event's lifetime. The Worker and Durable Object bridges close
 * an event's scope once its handler has returned and every piece of work it
 * was told about has settled: work handed to `waitUntil`, and a streamed
 * response body or RPC result. Provided per event, and read from the calling
 * fiber, so a context captured at init still reaches the live event.
 *
 * @internal
 */
export class EventLifetime extends Context.Service<
  EventLifetime,
  {
    /** Keep the event's scope open until `promise` settles. */
    readonly extend: (promise: Promise<unknown>) => void;
  }
>()("Cloudflare.Workers.EventLifetime") {}

/**
 * Run `effect` with the caller's context, hand its promise to `register`
 * (workerd's `waitUntil`) un-awaited, and extend the event's
 * {@link EventLifetime} until it settles.
 *
 * The event is found through {@link EventLifetime} rather than the ambient
 * `Scope`: work handed off inside an `Effect.scoped` region (an RPC request's
 * scope, say) must not hold that region open. The work gets a scope of its
 * own, so what it acquires lives as long as it does, not as long as the
 * region it was handed off from.
 *
 * @internal
 */
export const runInBackground = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  register: (promise: Promise<unknown>) => void,
): Effect.Effect<void, never, R | RuntimeContext> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const lifetime = yield* Effect.serviceOption(EventLifetime);
    yield* Effect.sync(() => {
      const promise = Effect.runPromiseWith(context)(effect.pipe(Effect.scoped));
      if (Option.isSome(lifetime)) lifetime.value.extend(promise);
      register(promise);
    });
  });

/**
 * Make the {@link EventLifetime} of an event whose scope is `scope`. Provide
 * `lifetime`, and call `holdScope` once the handler has returned: closing the
 * scope then waits for the work the event was told about, including work
 * started while waiting, before running the rest of its finalizers. So that
 * work can still use the event's resources, and its spans and logs reach the
 * event's exporters.
 *
 * Run `holdExporters` once the event's exporters are on the scope and before
 * the handler: work a handler's finalizer hands off is waited for again
 * before the exporters flush.
 *
 * @internal
 */
export const makeEventLifetime = (scope: Scope.Scope) => {
  const work: Array<Promise<unknown>> = [];
  const settled = Effect.promise(async () => {
    for (let seen = 0; seen < work.length;) {
      const batch = work.slice(seen);
      seen = work.length;
      await Promise.allSettled(batch);
    }
  });
  const lifetime: EventLifetime["Service"] = {
    extend: (promise) => void work.push(promise),
  };
  return {
    lifetime,
    // Added before the handler's own finalizers, so it runs after them.
    holdExporters: Scope.addFinalizer(scope, settled),
    // Added after the handler's own finalizers, so it runs before them.
    holdScope: (): void => Effect.runSync(Scope.addFinalizer(scope, settled)),
  };
};
