/**
 * The Effect-native WebSocket handle handed to Durable Object
 * `webSocketMessage` / `webSocketClose` handlers and returned by
 * `DurableObjectState.getWebSockets`.
 *
 * Part of the engine-invariant Worker/Durable Object runtime core shared by
 * the Cloudflare, Celld and Rivet bridges. The raw socket type is the
 * hibernatable-WebSocket API surface every engine presents (workerd's
 * natively; Rivet adapts its own sockets to it).
 *
 * @internal
 */
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

export type RawWebSocket = cf.WebSocket;

export interface WebSocket {
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
  serializeAttachment: (value) => ws.serializeAttachment(value),
  deserializeAttachment: () => ws.deserializeAttachment() as any,
});
