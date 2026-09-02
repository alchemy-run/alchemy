/**
 * The engine-invariant Worker runtime core shared by the Cloudflare, Celld
 * and Rivet bridges: the `WorkerEnvironment` service, the one-per-instance
 * layer build every export of an entrypoint shares, the per-export resolver
 * over it, and the RPC exit encoder.
 *
 * The engine supplies what differs — its platform services Layer, its
 * environment record, and any engine-specific services — through
 * {@link SharedBuildOptions}; nothing here imports an engine runtime.
 *
 * @internal
 */
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import { isScopeEjected } from "../Http.ts";
import {
  ErrorTag,
  encodeRpcError,
  toRpcStream,
  type RpcErrorEnvelope,
  type RpcStreamEnvelope,
} from "../Rpc.ts";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "../Runtime.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";
import { Self } from "../Self.ts";
import { Stack } from "../Stack.ts";

/**
 * The runtime environment record the worker was deployed with — workerd's
 * `env` object, or `process.env` inside a Node/Bun runner.
 */
export class WorkerEnvironment extends Context.Service<
  WorkerEnvironment,
  Record<string, any>
>()("Cloudflare.Workers.WorkerEnvironment") {}

/**
 * The isolate-lifetime artifacts produced by a single layer build: the built
 * service Context, the resolved export for this entrypoint, the user's
 * RPC shape (a thunk — the shape is only populated once `serve` has run),
 * and the telemetry Layer override registered during init (a thunk for the
 * same reason).
 */
export interface WorkerBuild<Export = any> {
  readonly context: Context.Context<any>;
  readonly export: Export;
  readonly shape: () => Record<string, any>;
  readonly telemetry: () => Layer.Layer<never, any, any> | undefined;
}

/**
 * `pin` registers an in-flight build promise with the calling event
 * (`ctx.waitUntil` / `state.waitUntil`). Every awaiting event must pin:
 * workerd schedules a promise's continuations back into its origin request
 * context and *drops* them if that context has ended
 * (`handle_cross_request_promise_resolution`), so the origin event must be
 * kept alive until the build settles or concurrent cold-start requests
 * would hang.
 */
export type Pin = (promise: Promise<unknown>) => unknown;

/** The engine-supplied half of a shared build. */
export interface SharedBuildOptions {
  /**
   * The platform services (file system, path, http client, logger, …) the
   * user's init closure and handlers run against.
   */
  readonly platform: Layer.Layer<any>;
  /** The runtime environment record — workerd `env` or `process.env`. */
  readonly env: Effect.Effect<Record<string, unknown>>;
  /**
   * Engine-specific services layered under the entrypoint (e.g. the
   * workerd execution context and account services), built from the
   * resolved environment record.
   */
  readonly extra?:
    | ((env: Record<string, unknown>) => Layer.Layer<any>)
    | undefined;
}

export type SharedBuild = (pin: Pin) => Promise<Context.Context<any>>;

/** The runtime-context surface the bridges read off the built `Self` service. */
interface WorkerSelf {
  readonly RuntimeContext: BaseRuntimeContext & {
    readonly exports: Effect.Effect<Record<string, any>>;
    readonly shape: () => Record<string, any>;
  };
}

const selfTag = Self as unknown as Context.Service<never, WorkerSelf>;

/**
 * One isolate-lifetime layer build per entrypoint module. The generated
 * entry passes the same `meta.entrypoint` object to every bridge factory
 * (worker, Durable Object, Workflow), so keying on it shares a single build
 * (one run of the user's init closure) across the default worker and every
 * hosted class in the instance. The first caller's {@link SharedBuildOptions}
 * win for an entrypoint.
 */
const sharedBuilds = new WeakMap<object, SharedBuild>();

export const getSharedBuild = (
  entrypoint: object,
  stack: { name: string; stage: string },
  options: SharedBuildOptions,
): SharedBuild => {
  let shared = sharedBuilds.get(entrypoint);
  if (shared !== undefined) {
    return shared;
  }

  const layer = makeEntrypointLayer(selfTag, entrypoint);

  // Private scope for the instance-lifetime layer build. Never closed on
  // workerd (no isolate-teardown hook, so finalizers attached here can never
  // run). It exists only because `Layer.buildWithMemoMap` requires a scope
  // argument (`Layer.scoped`-style layers attach their finalizers to it). It
  // is deliberately NOT provided as the ambient `Scope.Scope` of the init
  // context: request-coupled resources are acquired inside handlers against
  // the per-event scope that `processEvent` provides.
  const instanceScope = Scope.makeUnsafe();
  const memoMap = Layer.makeMemoMapUnsafe();

  const globalContext = Layer.unwrap(
    options.env.pipe(
      Effect.map((env) =>
        layer.pipe(
          Layer.provideMerge(
            Layer.succeed(Stack, {
              name: stack.name,
              stage: stack.stage,
              bindings: {},
              resources: {},
              actions: {},
            }),
          ),
          Layer.provideMerge(options.platform),
          Layer.provideMerge(
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.orElse(
                ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
                // Auto-bound `Config` values arrive in `env` as
                // `{"_tag":"Redacted","value":...}` markers; reify them so a
                // `Config` re-read inside a request handler decodes the raw
                // source value instead of the marker JSON.
                reifyBoundConfigProvider(ConfigProvider.fromUnknown(env), env),
              ),
            ),
          ),
          Layer.provideMerge(Layer.succeed(WorkerEnvironment, env)),
          Layer.provideMerge(options.extra?.(env) ?? Layer.empty),
          Layer.provideMerge(
            Layer.succeed(MinimumLogLevel, env.DEBUG ? "Debug" : "Info"),
          ),
        ),
      ),
    ),
  );

  let built: Promise<Context.Context<any>> | undefined;

  /**
   * Build the instance-lifetime layer stack exactly once; every subsequent
   * event (and every export sharing this entrypoint) reuses the memoized
   * Context.
   *
   * Only success is memoized — a transient init failure (e.g. a flaky
   * `Config` read in user init) resets the memo and heals on the next event.
   */
  shared = (pin) => {
    const promise = (built ??= Effect.runPromise(
      Layer.buildWithMemoMap(globalContext, memoMap, instanceScope).pipe(
        // Strip the build's memo map from the exposed context so a Layer the
        // user `Effect.provide`s *inside a handler* builds per event instead
        // of sharing one instance (pinned to the first request's IoContext)
        // across concurrent events.
        Effect.map(Context.omit(Layer.CurrentMemoMap)),
      ),
    ).catch((error) => {
      built = undefined;
      throw error;
    }));
    pin(promise.catch(() => {}));
    return promise;
  };
  sharedBuilds.set(entrypoint, shared);
  return shared;
};

/**
 * Resolve one named export (`default`, a Durable Object class, a Workflow
 * class) against the shared build; memoized so listener assembly and the
 * captured services context resolve once per export. Same success-only
 * memoization contract as the shared build.
 */
export const getWorkerExport = <Export = any>(
  {
    entrypoint,
    stack,
    exportName,
  }: {
    entrypoint: object;
    stack: { name: string; stage: string };
    exportName: string;
  },
  options: SharedBuildOptions,
) => {
  const runtimeContext = selfTag.pipe(
    Effect.map((self) => self.RuntimeContext),
  );
  const exported = runtimeContext.pipe(
    Effect.flatMap((context) => context.exports),
    Effect.flatMap((exports) =>
      Effect.isEffect(exports[exportName])
        ? exports[exportName]
        : Effect.succeed(exports[exportName]),
    ),
  ) as Effect.Effect<Export>;

  const sharedBuild = getSharedBuild(entrypoint, stack, options);

  let built: Promise<WorkerBuild<Export>> | undefined;

  const build = (pin: Pin): Promise<WorkerBuild<Export>> => {
    const promise = (built ??= sharedBuild(pin)
      .then((context) =>
        Effect.runPromise(
          Effect.all([exported, runtimeContext]).pipe(
            Effect.map(([exp, rc]): WorkerBuild<Export> => ({
              context,
              export: exp,
              shape: rc.shape,
              telemetry: () => rc.telemetry,
            })),
            Effect.provideContext(context),
          ),
        ),
      )
      .catch((error) => {
        built = undefined;
        throw error;
      }));
    pin(promise.catch(() => {}));
    return promise;
  };

  return { build };
};

/**
 * Encode an RPC call's exit for the wire: a `Stream` success becomes a
 * stream envelope (keeping the request scope open until the stream settles),
 * a typed failure becomes an error envelope, and a defect is thrown.
 */
export const handleRpcExit = async (
  exit: Exit.Exit<any, any>,
  scope?: Scope.Closeable,
) => {
  if (exit._tag === "Success") {
    if (Stream.isStream(exit.value)) {
      let stream = exit.value as Stream.Stream<any, any, any>;
      if (scope !== undefined && !isScopeEjected(scope)) {
        // The RPC transport drains the encoded ReadableStream *after* this
        // function returns, so the request scope must outlive the handler:
        // eject it from the bridge's close-on-return path and close it when
        // the stream settles instead — mirroring `scopeTransferToStream` on
        // the fetch path.
        EffectHttp.scopeDisableClose(scope);
        stream = stream.pipe(
          Stream.onExit((streamExit) => Scope.close(scope, streamExit)),
        );
      }
      return await Effect.runPromise(
        toRpcStream(stream) as Effect.Effect<RpcStreamEnvelope>,
      );
    }
    return exit.value;
  }
  const failReason = exit.cause.reasons.find(Cause.isFailReason);
  if (failReason) {
    return {
      _tag: ErrorTag,
      error: encodeRpcError(failReason.error),
    } satisfies RpcErrorEnvelope;
  }
  const dieReason = exit.cause.reasons.find(Cause.isDieReason);
  throw (
    dieReason?.defect ?? new Error("RPC method failed with an unexpected cause")
  );
};
