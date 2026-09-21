import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import type { Scope } from "effect/Scope";
import type { NativeContainer } from "./Containers/Native.ts";
import type { NativeFetcher } from "./Fetcher.ts";
import {
  fromNativeWorkerEntrypoint,
  type WorkerEntrypoint,
  type NativeWorkerExports,
} from "./WorkerEntrypoint.ts";
import type { NativeDurableObjectClass } from "./WorkerLoader.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { fromDurableObjectState as fromNativeState } from "../Workers/Workerd/DurableObjectState.ts";
import { fromWebSocket as fromNativeWebSocket } from "../Workers/Workerd/WebSocket.ts";
import type { DurableObjectStorage } from "./DurableObjectStorage.ts";
import type { WebSocket } from "./WebSocket.ts";

export type DurableObjectId = cf.DurableObjectId;
export type AlarmInvocationInfo = cf.AlarmInvocationInfo;

export interface FacetStartupOptions {
  /** Opaque class returned by a loaded Worker's getDurableObjectClass(). */
  class: NativeDurableObjectClass;
  /** Defaults to the parent Durable Object id. */
  id?: DurableObjectId | string;
}

/** Celld abort/delete schedule barriers but do not return completion promises. */
export interface NativeDurableObjectFacets {
  get(
    name: string,
    getStartupOptions: () => FacetStartupOptions | Promise<FacetStartupOptions>,
  ): NativeFetcher;
  abort(name: string, reason?: unknown): void;
  delete(name: string): void;
}

export class DurableObjectFacetError extends Data.TaggedError(
  "Celld.DurableObjectFacetError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface DurableObjectFacets {
  /**
   * Lazily start a facet, memoized by name in this parent instance. Maximum
   * nesting depth is four including the root. The handle stays in this event.
   */
  get<Shape = {}, E = never, R = never>(
    name: string,
    getStartupOptions: () =>
      | FacetStartupOptions
      | Effect.Effect<FacetStartupOptions, E, R>,
  ): Effect.Effect<
    WorkerEntrypoint<Shape>,
    DurableObjectFacetError,
    RuntimeContext | Scope | R
  >;
  /** Schedule abort; a subsequent get waits behind the native abort barrier. */
  abort(
    name: string,
    reason?: unknown,
  ): Effect.Effect<void, DurableObjectFacetError, RuntimeContext>;
  /** Schedule storage deletion, not an acknowledgement that deletion completed. */
  delete(
    name: string,
  ): Effect.Effect<void, DurableObjectFacetError, RuntimeContext>;
}

/** Capabilities implemented by Celld's own V8 harness, not workerd aliases. */
export interface NativeDurableObjectCapabilities {
  readonly container?: NativeContainer;
  readonly facets: NativeDurableObjectFacets;
  readonly exports: NativeWorkerExports;
  readonly props?: unknown;
}

/** Per-instance state supplied by the Celld V8 runtime. */
export interface DurableObjectStateService {
  /** Instance-bound native handle; operations create I/O within each calling event. */
  readonly container?: NativeContainer;
  readonly facets: DurableObjectFacets;
  /** Native loopback capabilities; only declared exports are present. */
  readonly exports: NativeWorkerExports;
  /** Structured-clone properties supplied to a facet class. */
  readonly props?: unknown;
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
    | "setWebSocketAutoResponse"
    | "getWebSocketAutoResponse"
    | "getWebSocketAutoResponseTimestamp"
  > & {
    abort(reason?: string): void;
    readonly storage: Omit<
      cf.DurableObjectStorage,
      | "getCurrentBookmark"
      | "getBookmarkForTime"
      | "onNextSessionRestoreBookmark"
    >;
  } & NativeDurableObjectCapabilities;
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
  /** Persist a native heartbeat pair, or remove it when omitted. */
  setWebSocketAutoResponse(
    pair?: cf.WebSocketRequestResponsePair,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Read the native heartbeat pair without waking retained sockets. */
  getWebSocketAutoResponse(): Effect.Effect<
    cf.WebSocketRequestResponsePair | null,
    never,
    RuntimeContext
  >;
  /** Last native auto-response timestamp for this socket. */
  getWebSocketAutoResponseTimestamp(
    ws: WebSocket["ws"],
  ): Effect.Effect<Date | null, never, RuntimeContext>;
  /** Reset the native cell. Celld does not support Cloudflare's retryAlarm option. */
  abort(reason?: string): Effect.Effect<void, never, RuntimeContext>;
}

export class DurableObjectState extends Context.Service<
  DurableObjectState,
  DurableObjectStateService
>()("Celld.DurableObjectState") {}

export const fromDurableObjectState = (
  state: cf.DurableObjectState,
): DurableObjectStateService => {
  const native = fromNativeState(state);
  // Celld harness.js creates these on ctx; the legacy bridge's input type is cf state.
  const capabilities = state as object as NativeDurableObjectCapabilities;
  return {
    id: native.id,
    storage: native.storage,
    raw: state as object as DurableObjectStateService["raw"],
    container: capabilities.container,
    facets: fromNativeFacets(() => capabilities.facets),
    get exports() {
      return capabilities.exports;
    },
    get props() {
      return capabilities.props;
    },
    waitUntil: native.waitUntil,
    blockConcurrencyWhile: native.blockConcurrencyWhile,
    acceptWebSocket: (socket, tags) =>
      native.acceptWebSocket(fromNativeWebSocket(socket.ws), tags),
    getWebSockets: native.getWebSockets,
    getTags: native.getTags,
    setWebSocketAutoResponse: native.setWebSocketAutoResponse,
    getWebSocketAutoResponse: native.getWebSocketAutoResponse,
    getWebSocketAutoResponseTimestamp: native.getWebSocketAutoResponseTimestamp,
    abort: (reason) => Effect.sync(() => state.abort(reason)),
  };
};

const facetFailure = (operation: string) => (cause: unknown) =>
  new DurableObjectFacetError({
    message: `Celld facet ${operation} failed`,
    cause,
  });

/** @internal */
export const fromNativeFacets = (
  get: () => NativeDurableObjectFacets,
): DurableObjectFacets => ({
  get: <Shape = {}, E = never, R = never>(
    name: string,
    getStartupOptions: () =>
      | FacetStartupOptions
      | Effect.Effect<FacetStartupOptions, E, R>,
  ) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      return yield* Effect.try({
        try: () =>
          fromNativeWorkerEntrypoint<Shape>(
            get().get(name, () => {
              const options = getStartupOptions();
              return Effect.isEffect(options)
                ? Effect.runPromise(options.pipe(Effect.provide(context)))
                : options;
            }),
          ),
        catch: facetFailure("get"),
      });
    }),
  abort: (name, reason) =>
    Effect.try({
      try: () => get().abort(name, reason),
      catch: facetFailure("abort"),
    }),
  delete: (name) =>
    Effect.try({
      try: () => get().delete(name),
      catch: facetFailure("delete"),
    }),
});
