import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DurableObjectState } from "./DurableObjectState.ts";
import { fromWebSocket } from "../../Workers/Workerd/WebSocket.ts";

export {
  fromWebSocket,
  WebSocketAttachmentError,
  type RawWebSocket,
  type WebSocket,
} from "../../Workers/Workerd/WebSocket.ts";

/** Accept a hibernatable WebSocket on the current Durable Object. */
export const upgrade = Effect.fn(function* () {
  const ctx = yield* DurableObjectState;
  const native = globalThis as unknown as {
    WebSocketPair: typeof cf.WebSocketPair;
    Response: typeof cf.Response;
  };
  const pair = yield* Effect.sync(() => new native.WebSocketPair());
  const serverSocket = fromWebSocket(pair[1]);
  yield* ctx.acceptWebSocket(serverSocket);
  const rawResponse = yield* Effect.sync(
    () =>
      new native.Response(null, {
        status: 101,
        webSocket: pair[0],
      }),
  );
  return [
    HttpServerResponse.setBody(
      HttpServerResponse.empty({ status: 101 }),
      HttpBody.raw(rawResponse),
    ),
    serverSocket,
  ] as const;
});
