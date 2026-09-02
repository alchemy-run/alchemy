/**
 * The engine-invariant Durable Object instance core shared by the
 * Cloudflare, Celld and Rivet bridges: build one instance of a class export
 * against the shared build, run each call under a fresh per-call `Scope`
 * with the instance's state and telemetry provided, and dispatch RPC
 * methods against the built shape.
 *
 * The engine's class (workerd's `DurableObject` subclass, a Rivet actor)
 * owns the lifecycle API — it hands this core the state service and its
 * `waitUntil` hook and picks the RPC dispatch mode.
 *
 * @internal
 */
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { HttpEffect } from "../Http.ts";
import { isScopeEjected } from "../Http.ts";
import { rpcMethodOf, serveRpc } from "../Rpc.ts";
import { buildEventTelemetry } from "../Telemetry.ts";
import {
  DurableObjectState,
  type DurableObjectExport,
  type DurableObjectShape,
} from "./DurableObject.ts";
import { handleRpcExit, type Pin, type WorkerBuild } from "./Worker.ts";
import { toRpcEffect } from "./WorkerBridge.ts";

/**
 * Lifecycle handlers dispatched by the bridge itself — never RPC methods.
 */
export const RESERVED_DURABLE_OBJECT_HANDLERS: ReadonlySet<string> = new Set([
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
]);

/** The built instance shape: the lifecycle handlers plus the RPC surface. */
export type DurableObjectInstanceShape = DurableObjectShape &
  Record<string, unknown>;

/** A built Durable Object instance plus the context its calls run under. */
export interface BuiltDurableObject {
  readonly instance: DurableObjectInstanceShape;
  readonly services: Context.Context<never>;
  readonly context: Context.Context<any>;
  readonly telemetry: () => Layer.Layer<never, any, any> | undefined;
}

export interface DurableObjectInstanceOptions {
  /** The class export resolved against the shared build. */
  readonly build: (pin: Pin) => Promise<WorkerBuild<DurableObjectExport>>;
  /** The engine's `DurableObjectState` service for this instance. */
  readonly state: DurableObjectState["Service"];
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
   * a migration — runs INSIDE it; started outside the gate, such I/O never
   * completes and the object is reset ("blockConcurrencyWhile() waited for
   * too long"). Default: run immediately.
   */
  readonly gate?: (
    run: () => Promise<BuiltDurableObject>,
  ) => Promise<BuiltDurableObject>;
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
   * `Scope.Scope`), the instance's `DurableObjectState`, and the event
   * telemetry. `onExit` turns the exit into the returned value (default:
   * the success value, or the squashed cause thrown); the scope closes into
   * `waitUntil` after the result unless a consumer ejected it.
   */
  readonly execute: <T = unknown>(
    fn: (instance: DurableObjectInstanceShape) => Effect.Effect<any, any, any>,
    onExit?: (exit: Exit.Exit<any, any>, scope: Scope.Closeable) => Promise<T>,
  ) => Promise<T>;
  /** An RPC method: run the named member of the shape and encode its exit for the wire. */
  readonly dispatch: (
    method: string,
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
  state,
  waitUntil,
  dispatch: mode,
  target,
  gate,
}: DurableObjectInstanceOptions): DurableObjectInstance => {
  const stateLayer = Layer.succeed(DurableObjectState, state);

  const instance: Promise<BuiltDurableObject> = (gate ?? ((run) => run()))(() =>
    build(waitUntil).then(({ context, export: exported, telemetry }) => {
      const { constructor, services } = exported;
      const doContext = stateLayer.pipe(
        Layer.provideMerge(Layer.succeedContext(services)),
        Layer.provideMerge(Layer.succeedContext(context)),
      );
      return constructor.pipe(
        Effect.provide(doContext),
        Effect.flatMap((instance) => instance.pipe(Effect.provide(doContext))),
        Effect.map((instance): BuiltDurableObject => ({
          instance: instance as DurableObjectInstanceShape,
          services,
          context,
          telemetry,
        })),
        Effect.runPromise,
      );
    }),
  );

  const execute = <T = unknown>(
    fn: (instance: DurableObjectInstanceShape) => Effect.Effect<any, any, any>,
    onExit?: (exit: Exit.Exit<any, any>, scope: Scope.Closeable) => Promise<T>,
  ): Promise<T> => {
    const scope = Scope.makeUnsafe();
    return instance
      .then(({ instance, services, context, telemetry }) =>
        fn(instance).pipe(
          Effect.provide(
            Layer.mergeAll(
              stateLayer,
              Layer.succeed(Scope.Scope, scope),
              // The configured telemetry exporters, attached to the *call*
              // scope by `buildEventTelemetry` so buffered telemetry
              // flushes when the scope closes into `waitUntil` below (the
              // instance scope never finalizes on workerd).
              Layer.effectContext(
                buildEventTelemetry(context, scope, telemetry()),
              ),
            ).pipe(
              Layer.provideMerge(Layer.succeedContext(services)),
              Layer.provideMerge(Layer.succeedContext(context)),
            ),
          ),
          Effect.runPromiseExit,
        ),
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
    (method: string) =>
    (...args: readonly unknown[]) =>
      execute((instance) => {
        const member = instance[method];
        return toRpcEffect(
          typeof member === "function" ? member(...args) : member,
        );
      }, handleRpcExit);

  if (mode === "static" && target !== undefined) {
    // Materialize the built shape's RPC surface as real methods. The engine
    // gates event delivery on `instance` (`blockConcurrencyWhile`), so every
    // RPC call observes the assigned methods.
    // A failed build is reported through `instance` itself; this branch only
    // observes success.
    void instance.then(
      (built) => {
        for (const name of Object.keys(built.instance)) {
          if (
            !RESERVED_DURABLE_OBJECT_HANDLERS.has(name) &&
            !(name in target)
          ) {
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
    instance: DurableObjectInstanceShape,
    request: { readonly url: string },
  ): HttpEffect<any> => {
    const own = instance.fetch ?? notImplemented;
    if (mode === "static" && rpcMethodOf(request) !== undefined) {
      const shape: Record<string, unknown> = {};
      for (const name of Object.keys(instance)) {
        if (RESERVED_DURABLE_OBJECT_HANDLERS.has(name)) continue;
        const member = instance[name];
        shape[name] = typeof member === "function" ? member : () => member;
      }
      return serveRpc(shape, own);
    }
    return own;
  };

  return { instance, execute, dispatch, fetch };
};
