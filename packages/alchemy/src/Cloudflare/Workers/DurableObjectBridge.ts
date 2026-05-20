import type * as cf from "@cloudflare/workers-types";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { HttpServerResponse } from "effect/unstable/http";
import type {
  DurableObjectExport,
  DurableObjectShape,
} from "./DurableObjectNamespace.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { makeRequestEffect } from "./HttpServer.ts";
import { fromWebSocket } from "./WebSocket.ts";
import { getWorkerExport } from "./WorkerBridge.ts";

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
  (className: string) =>
    class DurableObjectBridge extends DurableObject {
      #state;
      #globalContext;
      #exported;
      #instance;
      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);
        this.#state = state;

        const { globalContext, exported } =
          getWorkerExport<DurableObjectExport>({
            entrypoint,
            stack,
            exportName: className,
          });

        this.#globalContext = globalContext;
        this.#exported = exported;

        this.#instance = state.blockConcurrencyWhile(() =>
          this.#exported.pipe(
            Effect.flatMap(({ constructor, services }) =>
              constructor.pipe(
                Effect.provide(
                  Layer.succeed(
                    DurableObjectState,
                    fromDurableObjectState(this.#state),
                  ).pipe(Layer.provideMerge(Layer.succeedContext(services))),
                ),
                Effect.map((instance) => ({ instance, services })),
              ),
            ),
            Effect.provide(this.#globalContext),
            Effect.runPromise,
          ),
        );
      }

      async #execute(
        fn: (instance: DurableObjectShape) => Effect.Effect<any, any, any>,
      ) {
        const scope = Scope.makeUnsafe();

        const { instance, services } = await this.#instance;

        return fn(instance)
          .pipe(
            Effect.provide(
              Layer.succeed(
                DurableObjectState,
                fromDurableObjectState(this.#state),
              ).pipe(
                Layer.provideMerge(Layer.succeed(Scope.Scope, scope)),
                Layer.provideMerge(Layer.succeedContext(services)),
              ),
            ),
            Effect.provide(this.#globalContext),
            Effect.runPromiseExit,
          )
          .then((exit) =>
            exit._tag === "Success"
              ? Promise.resolve(exit.value)
              : Promise.reject(Cause.squash(exit.cause)),
          )
          .finally(() =>
            Scope.close(scope, Exit.void).pipe(Effect.runPromise, (promise) =>
              this.#state.waitUntil(promise),
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
    } as any;
