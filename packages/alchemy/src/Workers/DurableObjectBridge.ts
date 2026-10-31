/**
 * The engine-invariant Durable Object instance core shared by every
 * engine's bridge: build one instance of a class export
 * against the shared build, run each call under a fresh per-call `Scope`
 * with the instance's state and telemetry provided, and dispatch RPC
 * methods against the built shape.
 *
 * The engine's class (workerd's `DurableObject` subclass) owns the
 * lifecycle API — it hands this core the state service and its
 * `waitUntil` hook and picks the RPC dispatch mode.
 *
 * @internal
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";
import type { HttpEffect } from "../Http.ts";
import { isScopeEjected } from "../Http.ts";
import { rpcMethodOf, serveRpc } from "../Rpc.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import { buildEventTelemetry } from "../TelemetryRuntime.ts";
import type { DurableObjectExport, DurableObjectShape } from "./DurableObject.ts";
import { handleRpcExit, type Pin, type WorkerBuild } from "./Worker.ts";

/**
 * Lifecycle handlers dispatched by the bridge itself — never RPC methods.
 */
export const RESERVED_DURABLE_OBJECT_HANDLERS: ReadonlySet<string> = new Set([
  "fetch",
  "alarm",
  "webSocketOpen",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

/** The built instance shape: the lifecycle handlers plus the RPC surface. */
export type DurableObjectInstanceShape = DurableObjectShape & Record<string, unknown>;

/** A built Durable Object instance plus the context its calls run under. */
export interface BuiltDurableObject {
  readonly instance: DurableObjectInstanceShape;
  readonly services: Context.Context<never>;
  readonly context: Context.Context<any>;
  /** The instance's decorated runtime context. */
  readonly runtime: RuntimeContext["Service"];
  readonly telemetry: () => Layer.Layer<never, any, any> | undefined;
}

export interface DurableObjectInstanceOptions {
  /** The class export resolved against the shared build. */
  readonly build: (pin: Pin) => Promise<WorkerBuild<DurableObjectExport, any>>;
  /**
   * Engine services available during construction and every call (the
   * engine's Durable Object state service).
   */
  readonly services: Context.Context<never>;
  /**
   * Per-call engine services, built with the call's background-work hook
   * (`waitUntil` work started by the call records into its telemetry).
   */
  readonly callServices?:
    | ((track: (promise: Promise<unknown>) => void) => Context.Context<never>)
    | undefined;
  /** Decorate the instance's runtime context (e.g. its durable callback factory). */
  readonly runtimeContext?: (runtime: RuntimeContext["Service"]) => RuntimeContext["Service"];
  /** Open callback registration for inner initialization; return its seal hook. */
  readonly initialize?: () => () => void;
  /** Keep the instance alive until `promise` settles (`state.waitUntil`). */
  readonly waitUntil: Pin;
  /**
   * How RPC methods reach the instance:
   *
   * - `"proxy"` — the engine resolves method names dynamically (workerd's
   *   JSRPC dispatches through the bridge class's `Proxy`); `dispatch`
   *   builds each method on demand.
   * - `"static"` — the RPC surface is materialized as real methods on
   *   `target` once the instance builds (for engines whose RPC stalls on
   *   Proxy-returning constructors), and {@link DurableObjectInstance.fetch}
   *   serves the fetch-RPC protocol over the instance's own `fetch` so
   *   streaming results ride HTTP chunked bodies end-to-end (for engines
   *   whose native RPC cannot transfer `ReadableStream`s).
   */
  readonly dispatch: "proxy" | "static";
  /** `"static"` only: the object the RPC surface is materialized onto. */
  readonly target?: object | undefined;
  /**
   * Runs the instance build. Engines whose object constructor has no I/O
   * context outside a concurrency gate (workerd: `state.blockConcurrencyWhile`)
   * pass that gate here so an init that performs I/O — a D1 `CREATE TABLE`,
   * a migration — runs INSIDE it. Default: run immediately.
   */
  readonly gate?: (run: () => Promise<BuiltDurableObject>) => Promise<BuiltDurableObject>;
}

export interface DurableObjectInstance {
  /**
   * The instance, built once per in-memory activation: the export's
   * two-phase constructor runs with the state service and the captured
   * services provided. Rejects if the build fails (not memoized — see
   * `getWorkerExport`).
   */
  readonly instance: Promise<BuiltDurableObject>;
  /**
   * Run one call against the instance under a fresh `Scope` (provided as
   * `Scope.Scope`), the instance's state service, and the event
   * telemetry. `onExit` turns the exit into the returned value (default:
   * the success value, or the squashed cause thrown); the scope closes into
   * `waitUntil` after the result unless a consumer ejected it.
   */
  readonly execute: <T = unknown>(
    fn: (instance: DurableObjectInstanceShape) => Effect.Effect<any, any, any>,
    onExit?: (exit: Exit.Exit<any, any>, scope: Scope.Closeable) => Promise<T>,
  ) => Promise<T>;
  /**
   * An RPC method: run the named member of the shape and encode its exit for
   * the wire, as a child of `parent` (the caller's span) when given.
   */
  readonly dispatch: (
    method: string,
    parent?: Tracer.AnySpan,
  ) => (...args: readonly unknown[]) => Promise<unknown>;
  /**
   * The HTTP handler served for one request: in `"static"` mode a request
   * on the RPC path is served by `serveRpc` over the instance's RPC
   * surface; everything else is the instance's own `fetch` (404 when it has
   * none).
   */
  readonly fetch: (
    instance: DurableObjectInstanceShape,
    request: { readonly url: string },
  ) => HttpEffect<any>;
}

export const makeDurableObjectInstance = ({
  build,
  services: engineServices,
  callServices,
  waitUntil,
  dispatch: mode,
  target,
  gate,
  runtimeContext,
  initialize,
}: DurableObjectInstanceOptions): DurableObjectInstance => {
  const instance: Promise<BuiltDurableObject> = (gate ?? ((run) => run()))(() =>
    build(waitUntil).then(({ context, runtimeContext: runtime, export: exported, telemetry }) => {
      const { constructor, services } = exported;
      const instanceRuntimeContext = runtimeContext ? runtimeContext(runtime) : runtime;
      const doContext = Layer.succeedContext(engineServices).pipe(
        Layer.provideMerge(Layer.succeedContext(services)),
        Layer.provideMerge(Layer.succeedContext(context)),
      );
      return constructor.pipe(
        Effect.provide(doContext),
        Effect.flatMap((inner) =>
          Effect.suspend(() => {
            const seal = initialize?.();
            const instanceContext = Layer.succeed(RuntimeContext, instanceRuntimeContext).pipe(
              Layer.provideMerge(doContext),
            );
            return inner.pipe(
              Effect.provide(instanceContext),
              Effect.ensuring(Effect.sync(() => seal?.())),
            );
          }),
        ),
        Effect.map((built): BuiltDurableObject => ({
          instance: built as DurableObjectInstanceShape,
          services: Context.add(services, RuntimeContext, instanceRuntimeContext),
          context,
          runtime: instanceRuntimeContext,
          telemetry,
        })),
        Effect.runPromise,
      );
    }),
  );

  const execute = async <T = unknown>(
    fn: (instance: DurableObjectInstanceShape) => Effect.Effect<any, any, any>,
    onExit?: (exit: Exit.Exit<any, any>, scope: Scope.Closeable) => Promise<T>,
  ): Promise<T> => {
    const scope = Scope.makeUnsafe();
    // Work this call hands to `waitUntil` runs after it returns, in its
    // context, so it records into this call's telemetry. The exporters get
    // a scope of their own, flushed once that work (and any it starts)
    // settles; the call's scope closes as soon as the call does.
    const telemetryScope = Scope.makeUnsafe();
    const background: Array<Promise<unknown>> = [];
    const settled = async () => {
      for (let seen = 0; seen < background.length;) {
        const batch = background.slice(seen);
        seen = background.length;
        await Promise.allSettled(batch);
      }
    };
    // However the call's scope closes (here, or later by whoever ejected
    // it), flush telemetry once the background work has settled, without
    // holding up the close.
    Effect.runSync(
      Scope.addFinalizer(
        scope,
        Effect.sync(() =>
          waitUntil(
            settled().then(() => Effect.runPromise(Scope.close(telemetryScope, Exit.void))),
          ),
        ),
      ),
    );

    const { instance: shape, services, context, runtime, telemetry } = await instance;

    return fn(shape)
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeedContext(engineServices),
            Layer.succeedContext(
              callServices?.((promise) => void background.push(promise)) ?? Context.empty(),
            ),
            Layer.succeed(Scope.Scope, scope),
            // The instance's decorated runtime context (its durable callback
            // factory) wins over any the engine services carry.
            Layer.succeed(RuntimeContext, runtime),
            // The configured telemetry exporters, on their own scope:
            // flushed into `waitUntil` once the call's scope has closed and
            // its background work has settled (the instance scope never
            // finalizes on workerd).
            Layer.effectContext(buildEventTelemetry(context, telemetryScope, telemetry())),
          ).pipe(
            Layer.provideMerge(Layer.succeedContext(services)),
            Layer.provideMerge(Layer.succeedContext(context)),
          ),
        ),
        Effect.runPromiseExit,
      )
      .then((exit) =>
        onExit
          ? onExit(exit, scope)
          : exit._tag === "Success"
            ? Promise.resolve(exit.value as T)
            : Promise.reject(Cause.squash(exit.cause)),
      )
      .finally(() =>
        isScopeEjected(scope)
          ? undefined
          : waitUntil(
              // Match `processEvent`: yield one macrotask so the
              // HttpMiddleware tracer's late span-end reaches the telemetry
              // exporter before the scope's flush finalizer.
              new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
                Effect.runPromise(Scope.close(scope, Exit.void)),
              ),
            ),
      );
  };

  const dispatch =
    (method: string, parent?: Tracer.AnySpan) =>
    (...args: readonly unknown[]) =>
      execute(
        (shape) =>
          Effect.suspend(() => {
            if (!Object.hasOwn(shape, method)) {
              return Effect.die(new Error(`Method "${method}" not found on Durable Object`));
            }
            const member = shape[method];
            const result =
              typeof member === "function"
                ? (member as (...args: readonly unknown[]) => unknown)(...args)
                : member;
            // Effects (including nested-RPC values built by
            // `asEffectOrStream`, which are Effects branded as Streams) run
            // as effects; a genuine Stream is lifted into the success
            // channel for `handleRpcExit` to encode. The RPC Shape
            // constraint rejects any other member at declaration, so
            // anything else got past it with a cast.
            if (Effect.isEffect(result)) return result;
            if (Stream.isStream(result)) return Effect.succeed(result);
            return Effect.die(
              new Error(`Durable Object RPC member "${method}" must return an Effect or a Stream`),
            );
          }).pipe((effect) =>
            parent === undefined ? effect : Effect.withParentSpan(effect, parent),
          ),
        handleRpcExit,
      );

  if (mode === "static" && target !== undefined) {
    // Materialize the built shape's RPC surface as real methods. The engine
    // gates event delivery on `instance` (`blockConcurrencyWhile`), so every
    // RPC call observes the assigned methods. A failed build is reported
    // through `instance` itself; this branch only observes success.
    void instance.then(
      (built) => {
        for (const name of Object.keys(built.instance)) {
          if (!RESERVED_DURABLE_OBJECT_HANDLERS.has(name) && !(name in target)) {
            Reflect.set(target, name, dispatch(name));
          }
        }
      },
      () => {},
    );
  }

  const notImplemented = Effect.succeed(
    HttpServerResponse.text("Not implemented", { status: 404 }),
  );

  const fetch = (
    shape: DurableObjectInstanceShape,
    request: { readonly url: string },
  ): HttpEffect<any> => {
    const own = shape.fetch ?? notImplemented;
    if (mode === "static" && rpcMethodOf(request) !== undefined) {
      const rpcShape: Record<string, unknown> = {};
      for (const name of Object.keys(shape)) {
        if (RESERVED_DURABLE_OBJECT_HANDLERS.has(name)) continue;
        const member = shape[name];
        rpcShape[name] = typeof member === "function" ? member : () => member;
      }
      return serveRpc(rpcShape, own) as HttpEffect<any>;
    }
    return own as HttpEffect<any>;
  };

  return { instance, execute, dispatch, fetch };
};
