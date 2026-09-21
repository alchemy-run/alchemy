import * as Effect from "effect/Effect";
import type { UniversalWebSocket } from "rivetkit";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  makeAttachmentMethods,
  type AttachmentMethods,
} from "../Workers/WebSocketAttachment.ts";

export { WebSocketAttachmentError } from "../Workers/WebSocketAttachment.ts";

/** The native socket Rivet delivers to onWebSocket, already accepted. */
export type RawWebSocket = UniversalWebSocket;

/** Persisted connection state, separate from application actor state. @internal */
export interface RivetConnectionState {
  readonly version: 1;
  tags: string[];
  attachment?: unknown;
}

/** Native connection identity is stable across hibernation. @internal */
export interface RivetConnection {
  readonly id: string;
  state: RivetConnectionState;
}

/** An activation's native socket and persistent connection. @internal */
export interface ConnectedSocket {
  readonly socket: RawWebSocket;
  readonly connection: RivetConnection;
}

/** Effect operations supported by an already accepted native Rivet socket. */
export interface WebSocket extends AttachmentMethods {
  /** Native Rivet socket for interoperability. */
  readonly ws: RawWebSocket;
  /** Stable native connection identifier. */
  readonly id: string;
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

/** Reject values Rivet's JSON connection state cannot preserve faithfully. */
const jsonValue = (value: unknown, ancestors = new Set<object>()): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("Rivet socket attachments must be acyclic JSON values");
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new TypeError(
      "Rivet socket attachments must use JSON-compatible schema encoding",
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Rivet socket attachments cannot contain symbol keys");
  }
  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value))
    jsonValue(entry, ancestors);
  ancestors.delete(value);
};

/** @internal Native metadata and application codecs share one protected envelope. */
export const connectionAttachment = (connection: RivetConnection) => ({
  read: () => connection.state.attachment ?? null,
  write: (value: unknown) => {
    jsonValue(value);
    connection.state.attachment = JSON.parse(JSON.stringify(value));
  },
});

/** @internal The connection, not the activation's socket object, owns attachments. */
export const fromWebSocket = (
  ws: RawWebSocket,
  connection: RivetConnection,
): WebSocket => ({
  ws,
  id: connection.id,
  get readyState() {
    return ws.readyState;
  },
  send: (message) => Effect.sync(() => ws.send(message)),
  close: (code, reason) => Effect.sync(() => ws.close(code, reason)),
  ...makeAttachmentMethods(connectionAttachment(connection)),
});
