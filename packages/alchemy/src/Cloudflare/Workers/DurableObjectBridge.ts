import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

import { Cause, Stream } from "effect";
import type { HttpEffect } from "../../Http.ts";
import type { DurableObjectShape } from "./DurableObjectNamespace.ts";
import { makeRequestEffect } from "./HttpServer.ts";
import {
  encodeRpcError,
  ErrorTag,
  toRpcStream,
  type RpcErrorEnvelope,
  type RpcStreamEnvelope,
} from "./Rpc.ts";
import { fromWebSocket } from "./WebSocket.ts";

/**
 * Create a DurableObjectBridge class that proxies RPC method calls through
 * the Effect runtime, encoding success/fail/stream results as RPC envelopes.
 *
 * Accepts the `DurableObject` base class and a `getExport` resolver so the
 * implementation lives in real TypeScript instead of a generated string template.
 */
export const makeDurableObjectBridge =
  (
    DurableObject: abstract new (
      state: unknown,
      env: unknown,
    ) => cf.DurableObject,
    getExport: (
      name: string,
    ) => Promise<
      (state: unknown, env: unknown) => Effect.Effect<Record<string, unknown>>
    >,
  ) =>
  (className: string) =>
    class DurableObjectBridge extends DurableObject {
      readonly object: Promise<DurableObjectShape>;

      async fetch(request: cf.Request): Promise<cf.Response> {
        const methods = await this.object;
        if (methods.fetch) {
          const fetch = methods.fetch as HttpEffect<never>;
          const response = await makeRequestEffect(request, fetch).pipe(
            Effect.runPromise,
          );
          return response as any;
        } else {
          return new Response("Method not found", { status: 404 }) as any;
        }
      }

      async alarm(alarmInfo?: cf.AlarmInvocationInfo) {
        const methods = await this.object;
        if (methods.alarm) {
          await Effect.runPromise(methods.alarm(alarmInfo));
        }
      }

      async webSocketMessage(ws: cf.WebSocket, message: string | ArrayBuffer) {
        const methods = await this.object;
        if (methods.webSocketMessage) {
          const socket = fromWebSocket(ws);
          const value = methods.webSocketMessage(socket, message);
          if (Effect.isEffect(value)) {
            await Effect.runPromise(value as Effect.Effect<void>);
          }
        }
      }

      async webSocketClose(
        ws: cf.WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
      ) {
        const methods = await this.object;
        if (methods.webSocketClose) {
          const socket = fromWebSocket(ws);
          const value = methods.webSocketClose(socket, code, reason, wasClean);
          if (Effect.isEffect(value)) {
            await Effect.runPromise(value as Effect.Effect<void>);
          }
        }
      }

      constructor(
        state: {
          blockConcurrencyWhile: (
            fn: () => Promise<unknown>,
          ) => Promise<unknown>;
        },
        env: unknown,
      ) {
        super(state, env);

        this.object = state.blockConcurrencyWhile(async () => {
          const makeDurableObject = await getExport(className);
          return await Effect.runPromise(makeDurableObject(state, env));
        }) as Promise<any>;

        return new Proxy(this, {
          get: (target: any, prop) =>
            prop in target
              ? target[prop]
              : async (...args: unknown[]) => {
                  const methods = await this.object;
                  const method = methods[
                    prop as keyof DurableObjectShape
                  ] as any; // TODO(sam): what should the type be? Is it safe to always call it?
                  const value = method(...args);
                  if (Effect.isEffect(value)) {
                    const exit = await Effect.runPromiseExit(
                      value as Effect.Effect<unknown, never>,
                    );
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
                    const failReason = exit.cause.reasons.find(
                      Cause.isFailReason,
                    );
                    if (failReason) {
                      return {
                        _tag: ErrorTag,
                        error: encodeRpcError(failReason.error),
                      } satisfies RpcErrorEnvelope;
                    }
                    const dieReason = exit.cause.reasons.find(
                      Cause.isDieReason,
                    );
                    throw (
                      dieReason?.defect ??
                      new Error("RPC method failed with an unexpected cause")
                    );
                  }
                  return value;
                },
        });
      }
    };
