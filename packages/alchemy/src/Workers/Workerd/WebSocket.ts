/**
 * The Effect-native WebSocket handle handed to Durable Object
 * `webSocketMessage` / `webSocketClose` handlers and returned by
 * `DurableObjectState.getWebSockets`.
 *
 * Native attachment operations shared by Cloudflare and Celld. Rivet uses
 * the shared codec directly over its persistent connection state.
 *
 * @internal
 */
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import {
  makeAttachmentMethods,
  type AttachmentMethods,
} from "../WebSocketAttachment.ts";
export { WebSocketAttachmentError } from "../WebSocketAttachment.ts";

export type RawWebSocket = cf.WebSocket;

export interface WebSocket extends AttachmentMethods {
  readonly ws: RawWebSocket;
  send(data: string | Uint8Array): Effect.Effect<void>;
  close(code: number, reason: string): Effect.Effect<void>;
  serializeAttachment<T>(value: T): void;
  deserializeAttachment<T>(): T | null;
}

export const fromWebSocket = (ws: RawWebSocket): WebSocket => ({
  ws,
  send: (data) => Effect.sync(() => ws.send(data as any)),
  close: (code, reason) => Effect.sync(() => ws.close(code, reason)),
  ...makeAttachmentMethods({
    read: () => ws.deserializeAttachment(),
    write: (value) => ws.serializeAttachment(value),
  }),
});
