import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { fromWebSocket as fromNativeWebSocket } from "../Workers/Workerd/WebSocket.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import type { AttachmentMethods } from "../Workers/WebSocketAttachment.ts";
export { WebSocketAttachmentError } from "../Workers/WebSocketAttachment.ts";

export type RawWebSocket = cf.WebSocket;

/** A Celld hibernatable WebSocket. */
export interface WebSocket extends AttachmentMethods {
  readonly ws: RawWebSocket;
  send(data: string | Uint8Array): Effect.Effect<void, never, RuntimeContext>;
  close(
    code: number,
    reason: string,
  ): Effect.Effect<void, never, RuntimeContext>;
  serializeAttachment<T>(value: T): void;
  deserializeAttachment<T>(): T | null;
}

export const fromWebSocket = (socket: RawWebSocket): WebSocket =>
  fromNativeWebSocket(socket);

/** Accept a hibernatable WebSocket on the current Celld Durable Object. */
export const upgrade = Effect.fn(function* () {
  const state = yield* DurableObjectState;
  const pair = yield* Effect.sync(() => {
    const { WebSocketPair } = globalThis as unknown as {
      WebSocketPair: new () => { 0: RawWebSocket; 1: RawWebSocket };
    };
    return new WebSocketPair();
  });
  const socket = fromWebSocket(pair[1]);
  yield* state.acceptWebSocket(socket);
  const response = yield* Effect.sync(() => {
    const NativeResponse = Response as unknown as typeof cf.Response;
    return new NativeResponse(null, { status: 101, webSocket: pair[0] });
  });
  return [
    HttpServerResponse.setBody(
      HttpServerResponse.empty({ status: 101 }),
      HttpBody.raw(response),
    ),
    socket,
  ] as const;
});
