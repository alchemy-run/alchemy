import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { fromDurableObjectState as fromNativeState } from "../../Workers/Workerd/DurableObjectState.ts";
import {
  fromDurableObjectStorage,
  type DurableObjectStorage,
} from "./DurableObjectStorage.ts";
import type { WebSocket } from "./WebSocket.ts";

export type AlarmInvocationInfo = cf.AlarmInvocationInfo;
export type DurableObjectAbortOptions = cf.DurableObjectAbortOptions;

/** Per-instance state supplied by the Cloudflare Durable Object runtime. */
export interface DurableObjectStateService {
  readonly id: cf.DurableObjectId;
  readonly storage: DurableObjectStorage;
  container?: cf.Container;
  /** Keep the object alive until the effect, with its caller's context, settles. */
  waitUntil<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<void, never, R | RuntimeContext>;
  /** The native Cloudflare state for interop with async APIs. */
  readonly raw: cf.DurableObjectState;
  /** Hold other events while the callback runs with the caller's context. */
  blockConcurrencyWhile<T, R = never>(
    callback: () => Effect.Effect<T, never, R>,
  ): Effect.Effect<T, never, R | RuntimeContext>;
  acceptWebSocket(
    ws: WebSocket,
    tags?: string[],
  ): Effect.Effect<void, never, RuntimeContext>;
  getWebSockets(
    tag?: string,
  ): Effect.Effect<WebSocket[], never, RuntimeContext>;
  setWebSocketAutoResponse(
    maybeReqResp?: cf.WebSocketRequestResponsePair,
  ): Effect.Effect<void, never, RuntimeContext>;
  getWebSocketAutoResponse(): Effect.Effect<
    cf.WebSocketRequestResponsePair | null,
    never,
    RuntimeContext
  >;
  getWebSocketAutoResponseTimestamp(
    ws: cf.WebSocket,
  ): Effect.Effect<Date | null, never, RuntimeContext>;
  setHibernatableWebSocketEventTimeout(
    timeoutMs?: number,
  ): Effect.Effect<void, never, RuntimeContext>;
  getHibernatableWebSocketEventTimeout(): Effect.Effect<
    number | null,
    never,
    RuntimeContext
  >;
  getTags(ws: cf.WebSocket): Effect.Effect<string[], never, RuntimeContext>;
  /** Reset the isolate; retryAlarm defaults to true for an interrupted alarm. */
  abort(
    reason?: string,
    options?: DurableObjectAbortOptions,
  ): Effect.Effect<void, never, RuntimeContext>;
}

export class DurableObjectState extends Context.Service<
  DurableObjectState,
  DurableObjectStateService
>()("Cloudflare.DurableObjectState") {}

export const fromDurableObjectState = (
  state: cf.DurableObjectState,
): DurableObjectStateService => ({
  ...fromNativeState(state),
  storage: fromDurableObjectStorage(state.storage),
});
