import * as Effect from "effect/Effect";
import type { UniversalWebSocket } from "rivetkit";
import type { RuntimeContext } from "../RuntimeContext.ts";

/** The native socket Rivet delivers to onWebSocket, already accepted. */
export type RawWebSocket = UniversalWebSocket;

/** Effect operations supported by a native Rivet socket. */
export interface WebSocket {
  /** Native Rivet socket for interoperability. */
  readonly ws: RawWebSocket;
  /** Current native ready state. */
  readonly readyState: RawWebSocket["readyState"];
  /** Send a native text or binary payload. */
  send(
    message: Parameters<RawWebSocket["send"]>[0],
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Close the native connection. */
  close(
    code?: number,
    reason?: string,
  ): Effect.Effect<void, never, RuntimeContext>;
}

/** @internal Wrap only operations the native socket implements. */
export const fromWebSocket = (ws: RawWebSocket): WebSocket => ({
  ws,
  get readyState() {
    return ws.readyState;
  },
  send: (message) => Effect.sync(() => ws.send(message)),
  close: (code, reason) => Effect.sync(() => ws.close(code, reason)),
});
