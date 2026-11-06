import { acceptWebSocketPair } from "alchemy/Workers/Workerd/WebSocket";
import * as Effect from "effect/Effect";
import { DurableObjectState } from "./DurableObjectState.ts";

export {
  fromWebSocket,
  WebSocketAttachmentError,
  type RawWebSocket,
  type WebSocket,
} from "alchemy/Workers/Workerd/WebSocket";

// declare global {
//   const WebSocketPair: new () => [cf.WebSocket, cf.WebSocket];
// }

export interface UpgradeOptions {
  /**
   * Hibernation tags for the accepted socket. Look up every socket with a tag
   * via `state.getWebSockets(tag)` and read a socket's tags with
   * `state.getTags(socket.ws)`; both work after the Durable Object wakes from
   * hibernation, so group membership needs no in-memory state.
   *
   * Cloudflare allows at most 10 tags per WebSocket, each at most 256
   * characters.
   */
  readonly tags?: ReadonlyArray<string>;
}

/**
 * Accept a hibernatable WebSocket in a Durable Object's `fetch` handler.
 * Returns the `101 Switching Protocols` response to return from `fetch`, and
 * the server-side socket.
 *
 * @example
 * ```ts
 * const [response, socket] = yield* Cloudflare.upgrade({
 *   tags: [`user:${userId}`, "role:admin"],
 * });
 * // Later, even after hibernation:
 * for (const peer of yield* state.getWebSockets("role:admin")) {
 *   yield* peer.send("hello admins");
 * }
 * ```
 */
export const upgrade = Effect.fn(function* (options?: UpgradeOptions) {
  return yield* acceptWebSocketPair(yield* DurableObjectState, options?.tags);
});
