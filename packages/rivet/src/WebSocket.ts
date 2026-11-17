import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { PendingWebSocket } from "./internal/Sockets.ts";

/** A WebSocket a Durable Object instance accepted with {@link upgrade}. */
export interface WebSocket {
  /** The tags it was accepted with. */
  readonly tags: ReadonlyArray<string>;
  send(data: string | Uint8Array): Effect.Effect<void>;
  close(code?: number, reason?: string): Effect.Effect<void>;
  /** Keep a value with the socket, for as long as it is open. */
  serializeAttachment(value: unknown): void;
  /** The value kept with {@link serializeAttachment}, or `null`. */
  deserializeAttachment<T>(): T | null;
}

/** Options for {@link upgrade}. */
export interface UpgradeOptions {
  /**
   * Tags to find the socket by later, with `state.getWebSockets(tag)`.
   */
  readonly tags?: ReadonlyArray<string>;
}

/**
 * {@link upgrade} was called outside a `fetch` serving a WebSocket upgrade:
 * a defect, as calling it there is a bug.
 */
export class WebSocketUpgradeUnavailable extends Data.TaggedError(
  "Rivet.WebSocketUpgradeUnavailable",
)<{
  readonly message: string;
}> {}

/**
 * Accept the WebSocket the current `fetch` was called with. Returns the
 * `101 Switching Protocols` response to return from `fetch`, and the
 * socket. The instance's `webSocketMessage`, `webSocketClose` and
 * `webSocketError` handlers receive its events, and `state.getWebSockets()`
 * lists it until it closes.
 *
 * A caller reaches it with `stub.fetch(request)` on a request that asks for
 * an upgrade: Rivet's gateway carries the socket to the actor that owns the
 * key. The instance stays awake while it holds open sockets.
 *
 * @example
 * ```ts
 * fetch: Effect.gen(function* () {
 *   const [response, socket] = yield* Rivet.upgrade({ tags: ["room:lobby"] });
 *   yield* socket.send("welcome");
 *   return response;
 * }),
 * webSocketMessage: (socket, message) =>
 *   Effect.gen(function* () {
 *     for (const peer of yield* state.getWebSockets("room:lobby")) {
 *       if (peer !== socket) yield* peer.send(message);
 *     }
 *   }),
 * ```
 */
export const upgrade = Effect.fn("Rivet.upgrade")(function* (options?: UpgradeOptions) {
  const pending = yield* Effect.serviceOption(PendingWebSocket);
  if (pending._tag === "None") {
    return yield* Effect.die(
      new WebSocketUpgradeUnavailable({
        message: "Rivet.upgrade() can only accept the WebSocket of a fetch serving an upgrade.",
      }),
    );
  }
  const socket = yield* pending.value.accept(options?.tags ?? []);
  return [HttpServerResponse.empty({ status: 101 }), socket] as const;
});
