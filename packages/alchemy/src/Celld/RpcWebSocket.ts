import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RuntimeContext } from "../RuntimeContext.ts";
import * as Core from "../Workers/RpcWebSocket.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import { fromWebSocket, type WebSocket } from "./WebSocket.ts";

/** Native Celld acceptance, retention, and heartbeat adapter. */
export const make = Effect.gen(function* () {
  const state = yield* DurableObjectState;
  const runtime = yield* RuntimeContext;
  const inRuntime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
    Effect.provideService(effect, RuntimeContext, runtime);
  const native = globalThis as unknown as {
    WebSocketPair: typeof cf.WebSocketPair;
    WebSocketRequestResponsePair: typeof cf.WebSocketRequestResponsePair;
    Response: typeof cf.Response;
  };
  const raw = (socket: WebSocket): Core.Socket => ({
    ws: socket.ws,
    send: (data) => inRuntime(socket.send(data)),
    close: (code, reason) => inRuntime(socket.close(code, reason)),
    serializeAttachment: (value) => socket.ws.serializeAttachment(value),
    deserializeAttachment: () => socket.ws.deserializeAttachment(),
  });
  const transport = yield* Core.make({
    sockets: inRuntime(state.getWebSockets(Core.socketTag)).pipe(
      Effect.map((sockets) => sockets.map(raw)),
    ),
    waitUntil: (effect) => inRuntime(state.waitUntil(effect)),
    abort: (reason) => inRuntime(state.abort(reason)),
    heartbeat: {
      get: inRuntime(state.getWebSocketAutoResponse()),
      set: (pair) =>
        Effect.gen(function* () {
          const value =
            pair === undefined
              ? undefined
              : yield* Effect.sync(
                  () =>
                    new native.WebSocketRequestResponsePair(
                      pair.request,
                      pair.response,
                    ),
                );
          yield* inRuntime(state.setWebSocketAutoResponse(value));
        }),
    },
  });
  return {
    ...transport,
    accept: (socket: WebSocket) => transport.accept(raw(socket)),
    webSocketMessage: (socket: WebSocket, message: string | ArrayBuffer) =>
      transport.webSocketMessage(raw(socket), message),
    webSocketClose: (socket: WebSocket) =>
      transport.webSocketClose(raw(socket)),
    webSocketError: (socket: WebSocket, error: unknown) =>
      transport.webSocketError(raw(socket), error),
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (
        request.method !== "GET" ||
        request.headers.upgrade?.toLowerCase() !== "websocket"
      ) {
        return HttpServerResponse.empty({
          status: 426,
          headers: { Upgrade: "websocket" },
        });
      }
      const pair = yield* Effect.sync(() => new native.WebSocketPair());
      const socket = fromWebSocket(pair[1]);
      return yield* Effect.gen(function* () {
        yield* inRuntime(state.acceptWebSocket(socket, [Core.socketTag]));
        if (!(yield* transport.accept(raw(socket))))
          return HttpServerResponse.empty({ status: 503 });
        return yield* Effect.sync(() =>
          HttpServerResponse.setBody(
            HttpServerResponse.empty({ status: 101 }),
            HttpBody.raw(
              new native.Response(null, { status: 101, webSocket: pair[0] }),
            ),
          ),
        );
      }).pipe(
        Effect.catchCause(() =>
          transport
            .webSocketError(raw(socket), undefined)
            .pipe(Effect.as(HttpServerResponse.empty({ status: 503 }))),
        ),
        Effect.uninterruptible,
      );
    }),
  };
});

export type Transport = Effect.Success<typeof make>;
