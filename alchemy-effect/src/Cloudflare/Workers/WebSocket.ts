import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";
import { DurableObjectState } from "./DurableObject.ts";

export type RawWebSocket = cf.WebSocket;

export interface DurableWebSocket extends Socket.Socket {
  ws: RawWebSocket;
  close: (
    code: number,
    reason: string,
  ) => Effect.Effect<void, Socket.SocketError>;
  serializeAttachment: <T>(value: T) => Effect.Effect<void>;
  deserializeAttachment: <T>() => Effect.Effect<T>;
}

export const fromWebSocket = (ws: RawWebSocket) =>
  Socket.fromWebSocket(Effect.succeed(ws as any as WebSocket)).pipe(
    Effect.map(
      (socket) =>
        Object.assign(socket, {
          ws,
          close: (code: number, reason: string) =>
            Effect.sync(() => ws.close(code, reason)),
          serializeAttachment: <T>(value: T) =>
            Effect.sync(() => ws.serializeAttachment(value)),
          deserializeAttachment: <T>() =>
            Effect.sync(() => ws.deserializeAttachment() as T | null),
        }) as DurableWebSocket,
    ),
  );

export interface WebSocketHttpResponse
  extends HttpServerResponse.HttpServerResponse {
  webSocket: DurableWebSocket;
}

declare global {
  const WebSocketPair: new () => [cf.WebSocket, cf.WebSocket];
}

export const upgrade = Effect.fnUntraced(function* () {
  const _Response = Response as any as typeof cf.Response;
  const ctx = yield* DurableObjectState;
  const [client, server] = new WebSocketPair();
  const serverSocket = yield* fromWebSocket(server);
  yield* ctx.acceptWebSocket(serverSocket);
  const rawResponse = new _Response(null, {
    status: 101,
    webSocket: client,
  });
  // Store the raw Response as a Raw body so that HttpServerResponse.toWeb
  // detects `body.body instanceof Response` and returns it directly,
  // preserving the Cloudflare-specific `webSocket` property.
  const effectResponse = HttpServerResponse.setBody(
    HttpServerResponse.empty({ status: 101 }),
    HttpBody.raw(rawResponse),
  );
  return [effectResponse, serverSocket] as const;
});
