import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { fromDurableObjectState as fromNativeState } from "../Workers/Workerd/DurableObjectState.ts";
import { fromWebSocket as fromNativeWebSocket } from "../Workers/Workerd/WebSocket.ts";
import type { DurableObjectStorage } from "./DurableObjectStorage.ts";
import type { WebSocket } from "./WebSocket.ts";

export type DurableObjectId = cf.DurableObjectId;
export type AlarmInvocationInfo = cf.AlarmInvocationInfo;

/** Per-instance state supplied by a Celld workerd isolate. */
export interface DurableObjectStateService {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  /** Native state restricted to Celld's supported operations. */
  readonly raw: Pick<
    cf.DurableObjectState,
    | "id"
    | "waitUntil"
    | "blockConcurrencyWhile"
    | "acceptWebSocket"
    | "getWebSockets"
    | "getTags"
  > & {
    readonly storage: Omit<
      cf.DurableObjectStorage,
      | "getCurrentBookmark"
      | "getBookmarkForTime"
      | "onNextSessionRestoreBookmark"
    >;
  };
  /** Keep the instance alive while an effect runs with the caller's context. */
  waitUntil<A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<void, never, R | RuntimeContext>;
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
  getTags(ws: WebSocket["ws"]): Effect.Effect<string[], never, RuntimeContext>;
}

export class DurableObjectState extends Context.Service<
  DurableObjectState,
  DurableObjectStateService
>()("Celld.DurableObjectState") {}

export const fromDurableObjectState = (
  state: cf.DurableObjectState,
): DurableObjectStateService => {
  const native = fromNativeState(state);
  return {
    id: native.id,
    storage: native.storage,
    raw: native.raw,
    waitUntil: native.waitUntil,
    blockConcurrencyWhile: native.blockConcurrencyWhile,
    acceptWebSocket: (socket, tags) =>
      native.acceptWebSocket(fromNativeWebSocket(socket.ws), tags),
    getWebSockets: native.getWebSockets,
    getTags: native.getTags,
  };
};
