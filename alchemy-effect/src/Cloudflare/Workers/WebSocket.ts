import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";

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

export const upgrade: (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<[WebSocketHttpResponse, DurableWebSocket]> =
  Effect.fnUntraced(function* (request) {
    const socket = yield* request.upgrade;
    // TODO(sam): implement hibernation logic
    // TODO(sam): add serialize and deserialize attachments
    return socket;
  });
