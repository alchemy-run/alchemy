import { acceptWebSocketPair } from "alchemy/Workers/Workerd/WebSocket";
import * as Effect from "effect/Effect";
import { DurableObjectState } from "./DurableObjectState.ts";

export {
  fromWebSocket,
  WebSocketAttachmentError,
  type RawWebSocket,
  type WebSocket,
} from "alchemy/Workers/Workerd/WebSocket";

/**
 * Accept a hibernatable WebSocket in a Celld Durable Object's `fetch`
 * handler. Returns the `101 Switching Protocols` response to return from
 * `fetch`, and the server-side socket.
 */
export const upgrade = Effect.fn(function* (options?: { readonly tags?: ReadonlyArray<string> }) {
  return yield* acceptWebSocketPair(yield* DurableObjectState, options?.tags);
});
