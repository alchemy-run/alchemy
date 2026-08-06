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
import { RPC_PATH_PREFIX, serveRpc } from "../../Rpc.ts";
import { isScopeEjected, makeRequestEffect } from "./HttpServer.ts";
import { fromWebSocket } from "./WebSocket.ts";
import { getWorkerExport, handleRpcExit } from "./WorkerBridge.ts";

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
  (className: string, methods?: string[]) => {
    // One isolate-lifetime layer build shared by every activation of this DO
    // class: `build` memoizes the built context, so re-activations (including
    // hibernatable WebSocket wakes, which re-run the constructor) reuse it
    // instead of rebuilding the layer stack.
    const { build } = getWorkerExport<DurableObjectExport>({
      entrypoint,
      stack,
      exportName: className,
    });

    return class DurableObjectBridge extends DurableObject {
      #state;
      #instance;
      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);
        this.#state = state;

        this.#instance = state.blockConcurrencyWhile(() =>
          build((promise) => void (state as any).waitUntil?.(promise))
            .then(({ context, export: exported, telemetry }) => {
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
            })
            .then((built) => {
              if (methods !== undefined) {
                // Static-dispatch mode: materialize the built shape's RPC
                // surface as real instance methods. `blockConcurrencyWhile`
                // gates event delivery until this settles, so every RPC call
                // observes the assigned methods.
                for (const name of Object.keys(built.instance)) {
                  if (!(name in this)) {
                    (this as any)[name] = dispatch(name);
                  }
                }
              }
              return built;
            }),
        );

        const dispatch =
          (prop: string) =>
          (...args: any[]) =>
            this.#execute((instance) => {
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

        if (methods !== undefined) {
          // Static-dispatch mode (Celld fleets): celld's JSRPC stalls on
          // constructors that return a `Proxy` ("handler stalled: awaited
          // work with no pending op"), so the RPC surface is materialized as
          // real instance methods instead — any names known up front here,
          // and the built shape's methods in the `blockConcurrencyWhile`
          // continuation above.
          for (const method of methods) {
            if (!(method in this)) {
              (this as any)[method] = dispatch(method);
            }
          }
          return this;
        }

        return new Proxy(this, {
          get: (target, prop) => {
            const bind = (f: any) =>
              typeof f === "function" ? f.bind(target) : f;
            if (typeof prop !== "string") return bind((target as any)[prop]);
            if (prop in target) return bind((target as any)[prop]);
            return dispatch(prop);
          },
        });
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
        return this.#execute((instance) => {
          // Pre-declared-surface mode (Celld fleets): serve the RPC protocol
          // over the instance's own `fetch` so streaming results ride HTTP
          // chunked bodies end-to-end — celld's JSRPC cannot transfer
          // `ReadableStream`s across the cell boundary.
          if (methods !== undefined && request.url.includes(RPC_PATH_PREFIX)) {
            const reserved = new Set([
              "fetch",
              "alarm",
              "webSocketMessage",
              "webSocketClose",
            ]);
            const shape: Record<string, unknown> = {};
            for (const name of new Set([
              ...methods,
              ...Object.keys(instance),
            ])) {
              if (reserved.has(name)) continue;
              const member = (instance as any)[name];
              shape[name] =
                typeof member === "function" ? member : () => member;
            }
            return makeRequestEffect(
              request as any,
              serveRpc(
                shape,
                instance.fetch ??
                  Effect.succeed(
                    HttpServerResponse.text("Not implemented", {
                      status: 404,
                    }),
                  ),
              ),
            );
          }
          return instance.fetch
            ? makeRequestEffect(request as any, instance.fetch)
            : Effect.succeed(
                HttpServerResponse.text("Not implemented", {
                  status: 404,
                }),
              );
        });
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
    } as any;
  };
