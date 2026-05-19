import { NodeServices } from "@effect/platform-node";
import type cloudflare_workers from "cloudflare:workers";
import { Stream } from "effect";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/unstable/http";
import { ExecutionContext } from "../../ExecutionContext.ts";
import { makeEntrypointLayer } from "../../Runtime.ts";
import { Self } from "../../Self.ts";
import { Stack } from "../../Stack.ts";
import {
  ErrorTag,
  type RpcErrorEnvelope,
  type RpcStreamEnvelope,
  encodeRpcError,
  toRpcStream,
} from "./Rpc.ts";
import {
  ExportedHandlerMethods,
  Worker,
  WorkerEnvironment,
  WorkerExecutionContext,
} from "./Worker.ts";
import type { WorkerRuntimeContext } from "./WorkerRuntimeContext.ts";

/**
 * Create a `WorkerBridge` class — a `WorkerEntrypoint` subclass that
 * Cloudflare instantiates per request and dispatches both standard
 * handlers (`fetch`/`scheduled`/…) and RPC method calls into.
 *
 * The bridge is intentionally layer-ignorant: all runtime-layer plumbing
 * (services, scope, `WorkerExecutionContext`) lives in the platform's
 * `runtimeContext.exports` flow, which builds:
 *
 *   - `getDefault()` → `{ fetch, scheduled, … }` — handler dispatchers
 *     that the bridge forwards `(input, env, ctx)` to.
 *   - `getRpc()`     → `{ method: (args, ctx) => Promise<envelope> }` —
 *     pre-wrapped RPC dispatchers that already run the user effect with
 *     the right runtime layer and envelope-encode the result.
 *
 * Cloudflare's script-validate step requires standard handler methods
 * (`fetch`/`scheduled`/etc.) to be visible on the class prototype. We
 * declare static stubs there and override them per-instance with
 * closure-bound forwarders that capture `ctx`/`env` from the constructor
 * (prototype-level `this` doesn't survive the proxy + RPC dispatch
 * round-trip in some Cloudflare runtime versions).
 */
export const makeWorkerBridge = (
  WorkerEntrypoint: typeof cloudflare_workers.WorkerEntrypoint,
  {
    stack,
    entrypoint,
  }: {
    stack: {
      name: string;
      stage: string;
    };
    entrypoint: any;
  },
) => {
  class WorkerBridge extends WorkerEntrypoint {
    constructor(
      public readonly ctx: any,
      public readonly env: any,
    ) {
      super(ctx, env);

      const tag = Self as any as Context.Service<
        never,
        Worker & {
          RuntimeContext: WorkerRuntimeContext;
        }
      >;
      const layer = makeEntrypointLayer(tag, entrypoint);

      const platform = Layer.mergeAll(
        NodeServices.layer,
        FetchHttpClient.layer,
        // TODO(sam): wire this up to telemetry more directly
        Logger.layer([Logger.consolePretty()]),
      );

      const globalContext = layer.pipe(
        Layer.provideMerge(
          Layer.succeed(Stack, {
            name: stack.name,
            stage: stack.stage,
            bindings: {},
            resources: {},
            actions: {},
          }),
        ),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
              ConfigProvider.fromUnknown(env),
            ),
          ),
        ),
        Layer.provideMerge(Layer.succeed(WorkerEnvironment, env)),
        Layer.provideMerge(
          Layer.succeed(MinimumLogLevel, env.DEBUG ? "Debug" : "Info"),
        ),
      );

      const runtimeContext = tag.pipe(
        Effect.map((func) => func.RuntimeContext),
      );
      const userShape = runtimeContext.pipe(
        Effect.map((context) => context.shape()),
      );
      const exports = runtimeContext.pipe(
        Effect.flatMap((context) => context.exports),
      );
      const exportDefault = exports.pipe(
        Effect.map((exports) => exports.default),
      );

      const processEvent = (
        eff: Effect.Effect<[Effect.Effect<any>, Context.Context<never>]>,
      ) => {
        const scope = Scope.makeUnsafe();
        return eff
          .pipe(
            Effect.flatMap(([eff, context]) =>
              Effect.provide(
                eff,
                Layer.succeedContext(context).pipe(
                  Layer.provideMerge(Layer.succeedContext(context)),
                  Layer.provideMerge(
                    Layer.succeed(WorkerExecutionContext, this.ctx),
                  ),
                  Layer.provideMerge(
                    Layer.succeed(ExecutionContext, {
                      scope,
                      cache: {},
                    }),
                  ),
                ),
              ),
            ),
            Effect.provide(globalContext),
            Scope.provide(scope),
            Effect.runPromiseExit,
          )
          .finally(() =>
            Scope.close(scope, Exit.void).pipe(Effect.runPromise, (promise) =>
              this.ctx.waitUntil(promise),
            ),
          );
      };

      for (const methodName of ExportedHandlerMethods) {
        (this as any)[methodName] = async (input: any) =>
          exportDefault
            .pipe(
              Effect.map((_default) => _default[methodName]),
              Effect.map((f) => f(input, this.env, this.ctx)),
              processEvent,
            )
            .then((exit) =>
              exit._tag === "Success"
                ? Promise.resolve(exit.value)
                : Promise.reject(Cause.squash(exit.cause)),
            );
      }

      return new Proxy(this, {
        get: (target, prop) => {
          if (typeof prop !== "string") return (target as any)[prop];
          if (prop in target) return (target as any)[prop];
          return (...args: unknown[]) =>
            userShape
              .pipe(
                Effect.map((shape) => shape[prop]),
                Effect.flatMap((dispatcher) => {
                  if (typeof dispatcher !== "function") {
                    return Effect.die(
                      new Error(
                        `Method "${prop}" not found on worker. ` +
                          `Make sure it's returned from the worker's default export.`,
                      ),
                    );
                  }
                  return dispatcher(...args) as Effect.Effect<any>;
                }),
                processEvent,
              )
              .then(async (exit) => {
                if (exit._tag === "Success") {
                  if (Stream.isStream(exit.value)) {
                    return await Effect.runPromise(
                      toRpcStream(
                        exit.value,
                      ) as Effect.Effect<RpcStreamEnvelope>,
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
                  dieReason?.defect ??
                  new Error("RPC method failed with an unexpected cause")
                );
              });
        },
      });
    }
  }

  // Stub prototype methods so Cloudflare's script-validate detects the
  // standard handler set; per-instance overrides above are what actually
  // run.
  for (const method of ExportedHandlerMethods) {
    Object.defineProperty(WorkerBridge.prototype, method, {
      value: function () {
        throw new Error(
          `Bridge method '${method}' was called before instance setup`,
        );
      },
      writable: true,
      configurable: true,
    });
  }

  return WorkerBridge;
};
