import type * as cf from "@cloudflare/workers-types";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { HttpServerResponse } from "effect/unstable/http";
import { buildEventTelemetry } from "../../Telemetry.ts";
import type {
  DurableObjectExport,
  DurableObjectShape,
} from "./DurableObject.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { isScopeEjected, makeRequestEffect } from "./HttpServer.ts";
import { fromWebSocket } from "./WebSocket.ts";
import { getWorkerExport, handleRpcExit } from "./WorkerBridge.ts";

/** The dynamic RPC dispatcher method (see its JSDoc inside the bridge). */
const RPC_DISPATCH = Symbol.for("alchemy/DurableObjectBridge/rpcDispatch");

/**
 * Names the interposed prototype proxy must NEVER claim as RPC methods:
 * promise-assimilation probes (a claimed `then` makes every instance a
 * thenable), Object.prototype staples, and serialization probes. User RPC
 * methods with these names were never reachable dynamically either.
 */
const RPC_NAME_DENYLIST = new Set([
  "then",
  "catch",
  "finally",
  "constructor",
  "toString",
  "toJSON",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

/**
 * Create a DurableObjectBridge class that proxies RPC method calls through
 * the Effect runtime, encoding success/fail/stream results as RPC envelopes.
 *
 * Accepts the `DurableObject` base class and a `getExport` resolver so the
 * implementation lives in real TypeScript instead of a generated string template.
 */
export const makeDurableObjectBridge =
  (
    DurableObject: typeof DurableObjectClass,
    {
      entrypoint,
      stack,
    }: {
      entrypoint: Effect.Effect<Record<string, any>>;
      stack: {
        name: string;
        stage: string;
      };
    },
  ) =>
  (className: string) => {
    // One isolate-lifetime layer build shared by every activation of this DO
    // class: `build` memoizes the built context, so re-activations (including
    // hibernatable WebSocket wakes, which re-run the constructor) reuse it
    // instead of rebuilding the layer stack.
    const { build } = getWorkerExport<DurableObjectExport>({
      entrypoint,
      stack,
      exportName: className,
    });

    class DurableObjectBridge extends DurableObject {
      #state;
      #instance;
      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);
        this.#state = state;

        this.#instance = state.blockConcurrencyWhile(() =>
          build((promise) => void (state as any).waitUntil?.(promise)).then(
            ({ context, export: exported, telemetry }) => {
              const { constructor, services } = exported;
              const doContext = Layer.succeed(
                DurableObjectState,
                fromDurableObjectState(this.#state),
              ).pipe(
                Layer.provideMerge(Layer.succeedContext(services)),
                Layer.provideMerge(Layer.succeedContext(context)),
              );
              return constructor.pipe(
                Effect.provide(doContext),
                Effect.flatMap((instance) =>
                  instance.pipe(Effect.provide(doContext)),
                ),
                Effect.map((instance) => ({
                  instance,
                  services,
                  context,
                  telemetry,
                })),
                Effect.runPromise,
              );
            },
          ),
        );

        return new Proxy(this, {
          get: (target, prop) => {
            const bind = (f: any) =>
              typeof f === "function" ? f.bind(target) : f;
            if (typeof prop !== "string") return bind((target as any)[prop]);
            if (prop in target) return bind((target as any)[prop]);
            return async (...args: any[]) =>
              (target as any)[RPC_DISPATCH](prop, args);
          },
        });
      }

      /**
       * The dynamic RPC dispatcher: runs the named method of the user's
       * built DO shape inside the per-call scope. Reached two ways — the
       * instance proxy above (production workerd RPC does instance `get`s)
       * and the prototype proxy interposed below (the vite-plugin dev
       * runner resolves RPC methods on `ctor.prototype`).
       */
      async [RPC_DISPATCH](prop: string, args: any[]) {
        return this.#execute((instance) => {
          const method = instance[prop as keyof DurableObjectShape];
          if (typeof method === "function") {
            const result = (method as any)(...args);
            // Effects (including nested-RPC values built by
            // `asEffectOrStream`, which are Effects *branded* as Streams)
            // must be run as effects — their resolved value may itself be
            // a `Stream`, which `handleRpcExit` then encodes. Only a
            // *genuine* `Stream` (not an Effect) is lifted into the
            // success channel so `handleRpcExit` encodes it directly.
            return Effect.isEffect(result)
              ? result
              : Stream.isStream(result)
                ? Effect.succeed(result)
                : result;
          } else if (Effect.isEffect(method)) {
            return method;
          } else {
            return Effect.succeed(method);
          }
        }, handleRpcExit);
      }

      async #execute(
        fn: (instance: DurableObjectShape) => Effect.Effect<any, any, any>,
        onExit?: (
          exit: Exit.Exit<any, any>,
          scope: Scope.Closeable,
        ) => Promise<any>,
      ) {
        const scope = Scope.makeUnsafe();

        const { instance, services, context, telemetry } = await this.#instance;

        return fn(instance)
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(
                  DurableObjectState,
                  fromDurableObjectState(this.#state),
                ),
                Layer.succeed(Scope.Scope, scope),
                // The configured telemetry exporters, attached to the *call*
                // scope by `buildEventTelemetry` so buffered telemetry
                // flushes when the scope closes into `waitUntil` below (the
                // isolate scope never finalizes on workerd).
                Layer.effectContext(
                  buildEventTelemetry(context, scope, telemetry()),
                ),
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
                ? Promise.resolve(exit.value)
                : Promise.reject(Cause.squash(exit.cause)),
          )
          .finally(() =>
            isScopeEjected(scope)
              ? undefined
              : this.ctx.waitUntil(
                  // Match WorkerBridge: yield one macrotask so the
                  // HttpMiddleware tracer's late span-end reaches the
                  // telemetry exporter before the scope's flush finalizer.
                  new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
                    Effect.runPromise(Scope.close(scope, Exit.void)),
                  ),
                ),
          );
      }

      async fetch(request: Request): Promise<any> {
        return this.#execute((instance) =>
          instance.fetch
            ? makeRequestEffect(request as any, instance.fetch)
            : Effect.succeed(
                HttpServerResponse.text("Not implemented", {
                  status: 404,
                }),
              ),
        );
      }

      async alarm(alarmInfo?: cf.AlarmInvocationInfo) {
        return this.#execute((instance) => instance.alarm!(alarmInfo));
      }

      async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        return this.#execute(
          (instance) =>
            instance.webSocketMessage?.(fromWebSocket(ws as any), message) ??
            Effect.void,
        );
      }

      async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
      ) {
        return this.#execute(
          (instance) =>
            instance.webSocketClose?.(
              fromWebSocket(ws as any),
              code,
              reason,
              wasClean,
            ) ?? Effect.void,
        );
      }
    }

    // The vite-plugin dev runner resolves RPC methods on the CLASS
    // PROTOTYPE (`Reflect.has(ctor.prototype, key)` in `getRpcProperty`) —
    // it never consults the instance proxy production workerd RPC drives.
    // The user's method names only exist after the async layer build, so
    // they cannot be declared statically; instead an interposed prototype
    // proxy advertises any plausible RPC name and routes the call through
    // the same {@link RPC_DISPATCH} dispatcher, keeping dev semantics
    // byte-identical to production.
    const basePrototype = Object.getPrototypeOf(DurableObjectBridge.prototype);
    Object.setPrototypeOf(
      DurableObjectBridge.prototype,
      new Proxy(basePrototype, {
        // Chain-walk identity: `class X extends DurableObject` checks
        // (the dev runner's, and `instanceof`) walk [[GetPrototypeOf]]
        // until they meet `DurableObject.prototype` ITSELF. The proxy is
        // a different object, so it must hand the walk the real base —
        // making the chain `Bridge.prototype → proxy → base → …`.
        getPrototypeOf: () => basePrototype,
        has: (target, key) =>
          Reflect.has(target, key) ||
          (typeof key === "string" && !RPC_NAME_DENYLIST.has(key)),
        get: (target, key, receiver) => {
          if (
            typeof key !== "string" ||
            Reflect.has(target, key) ||
            RPC_NAME_DENYLIST.has(key)
          ) {
            return Reflect.get(target, key, receiver);
          }
          return function (this: any, ...args: any[]) {
            return (this ?? receiver)[RPC_DISPATCH](key, args);
          };
        },
      }),
    );

    return DurableObjectBridge as any;
  };
