import type * as cf from "@cloudflare/workers-types";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import type { DurableObjectExport } from "./DurableObjectNamespace.ts";
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
      #state: cf.DurableObjectState;

      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);
        this.#state = state;
      }

      async fetch(request: Request): Promise<any> {
        const scope = Scope.makeUnsafe();

        const { globalContext, exported } =
          getWorkerExport<DurableObjectExport>({
            entrypoint,
            stack,
            exportName: className,
          });

        return exported
          .pipe(
            Effect.flatMap(({ constructor, services }) =>
              constructor.pipe(
                Effect.flatMap((instance) =>
                  makeRequestEffect(request as any, instance.fetch!),
                ),
                Effect.provide(
                  Layer.succeed(
                    DurableObjectState,
                    fromDurableObjectState(this.#state),
                  ).pipe(
                    Layer.provideMerge(Layer.succeed(Scope.Scope, scope)),
                    Layer.provideMerge(Layer.succeedContext(services)),
                  ),
                ),
              ),
            ),
            Effect.provide(globalContext),
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

      async alarm(alarmInfo?: cf.AlarmInvocationInfo) {
        const methods = await this.#instance;
        if (methods.alarm) {
          await methods
            .alarm(alarmInfo)
            .pipe(Effect.provide(this.#services), Effect.runPromise);
        }
      }

      async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        const methods = await this.#instance;
        if (methods.webSocketMessage) {
          const socket = fromWebSocket(ws as any);
          const value = methods.webSocketMessage(socket, message);
          if (Effect.isEffect(value)) {
            await value.pipe(Effect.provide(this.#services), Effect.runPromise);
          }
        }
      }

      async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
      ) {
        const methods = await this.#instance;
        if (methods.webSocketClose) {
          const socket = fromWebSocket(ws as any);
          const value = methods.webSocketClose(socket, code, reason, wasClean);
          if (Effect.isEffect(value)) {
            await value.pipe(Effect.provide(this.#services), Effect.runPromise);
          }
        }
      }
    } as any;
