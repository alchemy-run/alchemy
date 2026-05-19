import type * as cf from "@cloudflare/workers-types";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as util from "util";

import { pipe } from "effect/Function";
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
      #instance;

      // @ts-expect-error - it is assigned, just not how TSC expects it
      #services: Layer.Layer<DurableObjectState>;

      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);

        const { globalContext, exported } =
          getWorkerExport<DurableObjectExport>({
            entrypoint,
            stack,
            exportName: className,
          });

        this.#instance = state.blockConcurrencyWhile(() =>
          exported.pipe(
            Effect.flatMap(({ constructor, services }) =>
              constructor.pipe(
                Effect.provide(
                  (this.#services = pipe(
                    Layer.succeed(
                      DurableObjectState,
                      fromDurableObjectState(state),
                    ),
                    Layer.provideMerge(Layer.succeedContext(services)),
                  )),
                ),
              ),
            ),
            Effect.provide(globalContext),
            Effect.tap((instance) =>
              Console.log("instance", util.inspect(instance, { depth: null })),
            ),
            Effect.tapError((err) =>
              Console.log("err", util.inspect(err, { depth: null })),
            ),
            Effect.tapCause((err) =>
              Console.log("cause", util.inspect(err, { depth: null })),
            ),
            Effect.runPromise,
          ),
        );
      }

      async fetch(request: Request): Promise<any> {
        const methods = await this.#instance;
        if (methods.fetch) {
          const response = await makeRequestEffect(
            request as any,
            methods.fetch,
          )
            .pipe(
              Effect.tap((response) =>
                Console.log(
                  "response",
                  util.inspect(response, { depth: null }),
                ),
              ),
              Effect.tapError((err) =>
                Console.log("fetch err", util.inspect(err, { depth: null })),
              ),
              Effect.tapCause((err) =>
                Console.log("fetch cause", util.inspect(err, { depth: null })),
              ),
              Effect.provide(this.#services),
              Effect.runPromise,
            )
            .catch((err) => {
              console.log(err);
              throw err;
            });
          console.log("response", util.inspect(response, { depth: null }));
          return response as any as cf.Response;
        } else {
          return new Response("Method not found", { status: 404 }) as any;
        }
      }

      async alarm(alarmInfo?: cf.AlarmInvocationInfo) {
        const methods = await this.#instance;
        if (methods.alarm) {
          await Effect.runPromise(methods.alarm(alarmInfo));
        }
      }

      async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        const methods = await this.#instance;
        if (methods.webSocketMessage) {
          const socket = fromWebSocket(ws as any);
          const value = methods.webSocketMessage(socket, message);
          if (Effect.isEffect(value)) {
            await Effect.runPromise(value as Effect.Effect<void>);
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
            await Effect.runPromise(value as Effect.Effect<void>);
          }
        }
      }
    } as any;
