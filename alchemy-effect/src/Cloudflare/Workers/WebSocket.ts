import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";

export interface DurableWebSocket extends Socket.Socket {
  close: (
    code: number,
    reason: string,
  ) => Effect.Effect<void, Socket.SocketError>;
  serializeAttachment: <T>(value: T) => Effect.Effect<void>;
  deserializeAttachment: <T>() => Effect.Effect<T>;
}

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
