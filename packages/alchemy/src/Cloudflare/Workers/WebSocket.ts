import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DurableObjectState } from "../../Workers/DurableObject.ts";
import { fromWebSocket } from "../../Workers/WebSocket.ts";

export {
  fromWebSocket,
  type RawWebSocket,
  type WebSocket,
} from "../../Workers/WebSocket.ts";

// declare global {
//   const WebSocketPair: new () => [cf.WebSocket, cf.WebSocket];
// }

export const upgrade = Effect.fn(function* () {
  const _Response = Response as any as typeof cf.Response;
  const ctx = yield* DurableObjectState;
  // @ts-expect-error
  const [client, server] = new WebSocketPair();
  const serverSocket = fromWebSocket(server);
  yield* ctx.acceptWebSocket(serverSocket);
  const rawResponse = new _Response(null, {
    status: 101,
    webSocket: client,
  });
  const effectResponse = HttpServerResponse.setBody(
    HttpServerResponse.empty({ status: 101 }),
    HttpBody.raw(rawResponse),
  );
  return [effectResponse, serverSocket] as const;
});
