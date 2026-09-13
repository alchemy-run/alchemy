/**
 * The engine-invariant event-dispatch core shared by the Cloudflare, Celld
 * and Rivet bridges: run one event's handler against a shared build under a
 * fresh per-event `Scope`, and normalize an RPC dispatcher's return value
 * into the effect the bridge runs.
 *
 * The engine's entrypoint class (workerd's `WorkerEntrypoint`, a runner's
 * server loop) owns the event API; it hands this core the per-event
 * services and its `waitUntil` hook.
 *
 * @internal
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { isScopeEjected } from "../Http.ts";
import { buildEventTelemetry } from "../Telemetry.ts";
import type { Pin, WorkerBuild } from "./Worker.ts";

export interface ProcessEventOptions<T> {
  /**
   * Select the handler effect for this event from the build, together with
   * the services captured when the export was assembled.
   */
  readonly makeEffect: (
    built: WorkerBuild,
  ) => readonly [Effect.Effect<any, any, any>, Context.Context<never>];
  /**
   * Per-event services that shadow the captured services and the built
   * instance context — e.g. the real per-event execution context, which
   * must win over the *deferred* one the instance context carries.
   */
  readonly services?: Layer.Layer<never> | undefined;
  /**
   * Keep the event alive until `promise` settles (`ctx.waitUntil`). Used
   * to pin the in-flight build and to close the request scope after the
   * response has been returned.
   */
  readonly waitUntil: Pin;
  /** Turn the handler's exit into the value returned to the engine. */
  readonly onExit: (
    exit: Exit.Exit<any, any>,
    scope: Scope.Closeable,
  ) => T | Promise<T>;
}

/**
 * Run one event: resolve the shared build (pinned to this event), run the
 * selected handler with a fresh request `Scope` provided as `Scope.Scope`
 * (so `Effect.addFinalizer` in a handler attaches to the request scope) and
 * the event's telemetry exporters, then close the scope into `waitUntil`
 * after the response — unless a consumer ejected the scope to outlive the
 * handler (a streaming body, an RPC stream).
 */
export const processEvent = <T>(
  build: (pin: Pin) => Promise<WorkerBuild>,
  {
    makeEffect,
    services = Layer.empty,
    waitUntil,
    onExit,
  }: ProcessEventOptions<T>,
): Promise<T> => {
  const scope = Scope.makeUnsafe();
  return build(waitUntil)
    .then(
      (built) => {
        const [eff, captured] = makeEffect(built);
        return eff.pipe(
          Effect.provide(
            Layer.mergeAll(
              services,
              Layer.succeed(Scope.Scope, scope),
              // The configured telemetry exporters. Constructed as part of
              // this per-event layer, but `buildEventTelemetry` attaches
              // their batching fibers and flush finalizers to the request
              // `scope` (not this build's transient scope), so buffered
              // telemetry flushes when the scope closes into `waitUntil`
              // below — never on the instance scope, which workerd never
              // finalizes.
              Layer.effectContext(
                buildEventTelemetry(built.context, scope, built.telemetry()),
              ),
            ).pipe(
              Layer.provideMerge(Layer.succeedContext(captured)),
              Layer.provideMerge(Layer.succeedContext(built.context)),
            ),
          ),
          Effect.runPromiseExit,
        );
      },
      // A failed instance build reaches callers as a defect exit so the RPC
      // path can envelope-encode it like any other handler defect.
      (error) => Exit.die(error),
    )
    .then((exit) => onExit(exit, scope))
    .finally(() =>
      isScopeEjected(scope)
        ? undefined
        : waitUntil(
            // The HttpMiddleware tracer ends the request's root span in a
            // dispatcher task scheduled after the handler effect resolves.
            // Yield one macrotask before closing the scope so that span
            // reaches the telemetry exporter's buffer before the scope's
            // flush finalizer runs.
            new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
              Effect.runPromise(Scope.close(scope, Exit.void)),
            ),
          ),
    );
};

/**
 * Normalize an RPC dispatcher's return value into the effect the bridge
 * runs. Effects (including nested-RPC values built by `asEffectOrStream`,
 * which are Effects *branded* as Streams) run as effects — their resolved
 * value may itself be a `Stream`, which `handleRpcExit` then encodes. A
 * *genuine* `Stream` (not an Effect) or a plain value is lifted into the
 * success channel so `handleRpcExit` encodes it directly.
 */
export const toRpcEffect = (
  result: unknown,
): Effect.Effect<unknown, unknown, any> =>
  Effect.isEffect(result)
    ? (result as Effect.Effect<unknown, unknown, any>)
    : Effect.succeed(result);

/**
 * Dispatch an RPC method call against a shape: a missing method is a
 * defect (the caller named something the worker never exported).
 */
export const dispatchRpcMethod = (
  shape: Record<string, unknown> | undefined,
  method: string,
  args: readonly unknown[],
): Effect.Effect<unknown, unknown, any> => {
  const dispatcher = shape?.[method];
  if (typeof dispatcher !== "function") {
    return Effect.die(
      new Error(
        `Method "${method}" not found on worker. ` +
          `Make sure it's returned from the worker's default export.`,
      ),
    );
  }
  return toRpcEffect(dispatcher(...args));
};
