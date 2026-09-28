import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import {
  hasRpcMetadata,
  readRpcMetadata,
  writeRpcMetadata,
} from "./WebSocketAttachment.ts";

export const socketTag = "alchemy:rpc";
const restartReason = "Durable Object RPC activation reset";
const Metadata = Schema.Struct({
  version: Schema.Literal(1),
  clientId: Schema.Number,
  pending: Schema.Boolean,
  serialization: Schema.String,
});
const isMetadata = Schema.is(Metadata);

export interface Socket {
  readonly ws: object;
  send(data: string | Uint8Array): Effect.Effect<void>;
  close(code: number, reason: string): Effect.Effect<void>;
  serializeAttachment<T>(value: T): void;
  deserializeAttachment<T>(): T | null;
}

export interface NativeAdapter<S extends Socket, R = never> {
  readonly sockets: Effect.Effect<readonly S[], never, R>;
  readonly waitUntil: (
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<void, never, R>;
  readonly abort: (reason: string) => Effect.Effect<void, never, R>;
  /** Allocate a durable unique identifier when retained sockets arrive lazily. */
  readonly allocateClientId?: Effect.Effect<number, never, R>;
  /** Persist the envelope using the current native invocation before dispatch or idle. */
  readonly flush?: (socket: S) => Effect.Effect<void, never, R>;
  readonly heartbeat?: {
    readonly get: Effect.Effect<
      { request: string; response: string } | null,
      never,
      R
    >;
    readonly set: (
      pair: { request: string; response: string } | undefined,
    ) => Effect.Effect<void, never, R>;
  };
}

interface Connection<S extends Socket, R> {
  readonly id: number;
  readonly socket: S;
  readonly parser: RpcSerialization.Parser;
  readonly pending: Set<string | number>;
  readonly tracked: Set<string | number>;
  readonly idle: Latch.Latch;
  readonly ready: Latch.Latch;
  flushing: number;
  context: Context.Context<R>;
  readonly requests: Map<string | number, Context.Context<R>>;
}

export interface Transport<S extends Socket = Socket, R = never> {
  readonly protocol: RpcServer.Protocol["Service"];
  /** Detach before RpcServer shutdown without touching retained native sockets. */
  readonly retire: Effect.Effect<void>;
  /** Register a connection already accepted by its native host. */
  readonly accept: (socket: S) => Effect.Effect<boolean, never, R>;
  readonly webSocketMessage: (
    socket: S,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, never, R>;
  readonly webSocketClose: (socket: S) => Effect.Effect<void, never, R>;
  readonly webSocketError: (
    socket: S,
    error: unknown,
  ) => Effect.Effect<void, never, R>;
  /** Keep recovery metadata pending until the complete request fiber has finalized. */
  readonly trackRequest: (
    clientId: number,
    requestId: string | number,
    fiber: Fiber.Fiber<unknown, unknown>,
  ) => Effect.Effect<void>;
}

/** Per-activation protocol; native acceptance and persistence stay in the adapter. */
export const make = <S extends Socket, R = never>(
  adapter: NativeAdapter<S, R>,
): Effect.Effect<
  Transport<S, R>,
  never,
  RpcSerialization.RpcSerialization | R
> =>
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    const disconnects = yield* Queue.make<number>();
    const ready = yield* Latch.make();
    const bySocket = new Map<object, Connection<S, R>>();
    const byId = new Map<number, Connection<S, R>>();
    const closed = new WeakSet<object>();
    let nextId = 0;
    let restoring = true;
    let stopped = false;
    let receive:
      | Parameters<RpcServer.Protocol["Service"]["run"]>[0]
      | undefined;

    const heartbeat = yield* Effect.sync(() => {
      const parser = serialization.makeUnsafe();
      const ping = parser.encode(RpcMessage.constPing);
      const pong = parser.encode(RpcMessage.constPong);
      return typeof ping === "string" && typeof pong === "string"
        ? { request: ping, response: pong }
        : undefined;
    });
    const existing = adapter.heartbeat ? yield* adapter.heartbeat.get : null;
    if (
      existing !== null &&
      (heartbeat === undefined ||
        existing.request !== heartbeat.request ||
        existing.response !== heartbeat.response)
    ) {
      return yield* Effect.die(
        new Error(
          "RPC WebSockets require exclusive ownership of auto-response",
        ),
      );
    }
    let heartbeatEnabled = existing !== null;

    const syncHeartbeat = Effect.suspend(() => {
      if (stopped) return Effect.void;
      const enabled =
        !restoring &&
        !stopped &&
        heartbeat !== undefined &&
        adapter.heartbeat !== undefined &&
        byId.size > 0 &&
        !Array.from(byId.values()).some(
          (connection) =>
            connection.pending.size > 0 || connection.flushing > 0,
        );
      if (enabled === heartbeatEnabled) return Effect.void;
      return (
        adapter.heartbeat?.set(enabled ? heartbeat : undefined) ?? Effect.void
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            heartbeatEnabled = enabled;
          }),
        ),
        Effect.catchCause(() =>
          adapter.abort("Unable to update RPC WebSocket heartbeat"),
        ),
      );
    });
    yield* syncHeartbeat;

    const persist = (connection: Connection<S, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          connection.flushing++;
        }),
        () =>
          Effect.sync(() => {
            const previous = connection.socket.deserializeAttachment<unknown>();
            connection.socket.serializeAttachment(
              writeRpcMetadata(previous, {
                version: 1,
                clientId: connection.id,
                pending: connection.pending.size > 0,
                serialization: serialization.contentType,
              } satisfies typeof Metadata.Type),
            );
          }).pipe(
            Effect.andThen(
              Effect.suspend(
                () => adapter.flush?.(connection.socket) ?? Effect.void,
              ),
            ),
          ),
        () =>
          Effect.sync(() => {
            connection.flushing--;
          }),
      );

    const unregister = (socket: S) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          closed.add(socket.ws);
          const connection = bySocket.get(socket.ws);
          if (connection === undefined) return;
          bySocket.delete(socket.ws);
          byId.delete(connection.id);
          connection.pending.clear();
          connection.idle.openUnsafe();
          connection.ready.openUnsafe();
          Queue.offerUnsafe(disconnects, connection.id);
        });
        yield* syncHeartbeat;
      });

    const close = (socket: S, code = 1012, reason = restartReason) =>
      Effect.suspend(() =>
        stopped ? Effect.void : socket.close(code, reason),
      ).pipe(
        Effect.catchCause(() => adapter.abort("Unable to close RPC WebSocket")),
        Effect.ensuring(unregister(socket)),
        Effect.uninterruptible,
      );

    const register = (
      socket: S,
      id: number,
      context: Context.Context<R>,
    ): Connection<S, R> => {
      const connection: Connection<S, R> = {
        id,
        socket,
        parser: serialization.makeUnsafe(),
        pending: new Set(),
        tracked: new Set(),
        idle: Latch.makeUnsafe(true),
        ready: Latch.makeUnsafe(),
        flushing: 0,
        context,
        requests: new Map(),
      };
      bySocket.set(socket.ws, connection);
      byId.set(id, connection);
      nextId = Math.max(nextId, id + 1);
      return connection;
    };

    const restoreOrRegister = (socket: S, retained: boolean) =>
      Effect.gen(function* () {
        if (closed.has(socket.ws)) return false;
        const existing = bySocket.get(socket.ws);
        if (existing) {
          yield* existing.ready.await;
          return bySocket.get(socket.ws) === existing;
        }
        const attachment = yield* Effect.sync(() =>
          socket.deserializeAttachment<unknown>(),
        );
        let id = nextId;
        if (retained || hasRpcMetadata(attachment)) {
          const metadata = readRpcMetadata(attachment);
          if (
            !isMetadata(metadata) ||
            metadata.pending ||
            metadata.serialization !== serialization.contentType ||
            !Number.isSafeInteger(metadata.clientId) ||
            metadata.clientId < 0 ||
            byId.has(metadata.clientId)
          ) {
            yield* close(socket);
            return false;
          }
          id = metadata.clientId;
        } else if (adapter.allocateClientId) {
          id = yield* adapter.allocateClientId;
          if (!Number.isSafeInteger(id) || id < 0 || byId.has(id)) {
            yield* close(socket);
            return false;
          }
        }
        const context = yield* Effect.context<R>();
        const connection = yield* Effect.sync(() =>
          register(socket, id, context),
        );
        yield* persist(connection);
        yield* connection.ready.open;
        yield* syncHeartbeat;
        return true;
      }).pipe(
        Effect.catchCause(() => close(socket).pipe(Effect.as(false))),
        Effect.uninterruptible,
      );

    for (const socket of yield* adapter.sockets) {
      yield* restoreOrRegister(socket, true);
    }
    restoring = false;
    yield* syncHeartbeat;

    const send = (
      connection: Connection<S, R>,
      response: RpcMessage.FromServerEncoded,
    ) =>
      Effect.gen(function* () {
        if (!byId.has(connection.id)) return;
        const encoded = yield* Effect.sync(() =>
          connection.parser.encode(response),
        );
        // Buffered responses cannot be recovered after hibernation.
        if (encoded === undefined) return yield* close(connection.socket);
        yield* connection.socket.send(encoded);
        if (
          response._tag === "Exit" &&
          !connection.tracked.has(response.requestId)
        ) {
          connection.pending.delete(response.requestId);
          connection.requests.delete(response.requestId);
          yield* persist(connection);
          if (connection.pending.size === 0) yield* connection.idle.open;
          yield* syncHeartbeat;
        }
        if (
          response._tag === "Defect" ||
          response._tag === "ClientProtocolError"
        ) {
          yield* close(connection.socket);
        }
      }).pipe(
        Effect.catchCause(() => close(connection.socket)),
        Effect.uninterruptible,
      );

    const retire = Effect.sync(() => {
      stopped = true;
      receive = undefined;
      ready.openUnsafe();
      for (const connection of byId.values()) {
        connection.ready.openUnsafe();
        connection.idle.openUnsafe();
      }
      // Recovery metadata must survive cancellation of server fibers and their finalizers.
      bySocket.clear();
      byId.clear();
    });

    const protocol = RpcServer.Protocol.of({
      run: (write) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            if (receive !== undefined || stopped) {
              throw new Error(
                "RPC WebSocket protocol is already running or stopped",
              );
            }
            receive = write;
          }),
          () => ready.open.pipe(Effect.andThen(Effect.never)),
          () => retire,
        ),
      disconnects,
      send: (id, response) =>
        Effect.suspend(() => {
          const connection = byId.get(id);
          return connection === undefined
            ? Effect.void
            : send(connection, response).pipe(
                Effect.provide(
                  "requestId" in response
                    ? (connection.requests.get(response.requestId) ??
                        connection.context)
                    : connection.context,
                ),
              );
        }),
      end: (id) =>
        Effect.suspend(() => {
          const connection = byId.get(id);
          return connection === undefined
            ? Effect.void
            : close(connection.socket, 1000, "").pipe(
                Effect.provide(connection.context),
              );
        }),
      clientIds: Effect.sync(() => new Set(byId.keys())),
      initialMessage: Effect.succeedNone,
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: true,
      supportsNotifications: true,
      codecFor: serialization.codecFor,
    });

    const accept = (socket: S) =>
      Effect.gen(function* () {
        yield* ready.await;
        if (stopped) return false;
        return yield* restoreOrRegister(socket, false);
      }).pipe(
        Effect.catchCause(() => close(socket).pipe(Effect.as(false))),
        Effect.uninterruptible,
      );

    const trackRequest: Transport<S, R>["trackRequest"] = (
      clientId,
      requestId,
      fiber,
    ) =>
      Effect.gen(function* () {
        const connection = byId.get(clientId);
        if (!connection) return;
        connection.tracked.add(requestId);
        yield* adapter
          .waitUntil(
            Fiber.await(fiber).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  if (!byId.has(clientId)) return;
                  connection.tracked.delete(requestId);
                  connection.pending.delete(requestId);
                  connection.requests.delete(requestId);
                  yield* persist(connection);
                  if (connection.pending.size === 0)
                    yield* connection.idle.open;
                  yield* syncHeartbeat;
                }),
              ),
              Effect.catchCause(() => close(connection.socket)),
            ),
          )
          .pipe(
            Effect.provide(
              connection.requests.get(requestId) ?? connection.context,
            ),
          );
      });

    const webSocketMessage = (socket: S, message: string | ArrayBuffer) =>
      Effect.gen(function* () {
        if (stopped || closed.has(socket.ws)) return;
        yield* ready.await;
        const connection = bySocket.get(socket.ws);
        if (connection === undefined || receive === undefined)
          return yield* close(socket);
        yield* connection.ready.await;
        if (bySocket.get(socket.ws) !== connection) return;
        connection.context = yield* Effect.context<R>();
        const messages = yield* Effect.sync(() =>
          connection.parser.decode(
            typeof message === "string" ? message : new Uint8Array(message),
          ),
        );
        // The serializer owns the envelopes; RpcServer validates payloads and schemas.
        const requests =
          messages as ReadonlyArray<RpcMessage.FromClientEncoded>;
        let hasRequests = false;
        for (const request of requests) {
          if (request._tag !== "Request") continue;
          if (
            (typeof request.id !== "string" &&
              !(
                typeof request.id === "number" && Number.isFinite(request.id)
              )) ||
            connection.pending.has(request.id)
          ) {
            return yield* close(socket);
          }
          connection.pending.add(request.id);
          connection.requests.set(request.id, connection.context);
          hasRequests = true;
        }
        if (hasRequests) {
          yield* connection.idle.close;
          // Mark the entire batch before dispatching even its first request.
          yield* persist(connection);
          yield* syncHeartbeat;
          yield* adapter.waitUntil(connection.idle.await);
        }
        for (const request of requests) {
          if (!byId.has(connection.id)) return;
          // Direct dispatch preserves this event's context; RpcServer creates each RPC scope.
          yield* receive(connection.id, request);
        }
      }).pipe(Effect.catchCause(() => close(socket)));

    return {
      protocol,
      retire,
      accept,
      trackRequest,
      webSocketMessage,
      webSocketClose: (socket) => close(socket, 1000, ""),
      webSocketError: (socket) => close(socket),
    } satisfies Transport<S, R>;
  });
