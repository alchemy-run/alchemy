import type { RuntimeContext } from "../RuntimeContext.ts";
import * as Effect from "effect/Effect";
import * as RpcWebSocket from "../Workers/RpcWebSocket.ts";
import {
  DurableObjectState,
  NativeContext,
  type RivetActorContext,
} from "./DurableObjectState.ts";
import {
  connectionAttachment,
  type WebSocket,
  type RivetConnection,
} from "./WebSocket.ts";

/** Native synchronous metadata writes, followed by the protocol's durability flush. */
const protocolSocket = (socket: WebSocket): RpcWebSocket.Socket => ({
  ws: socket.ws,
  send: (data) => Effect.sync(() => socket.ws.send(data)),
  close: (code, reason) =>
    Effect.sync(() => {
      // Native shutdown retains the connection; only a live invocation may close it.
      if (!connections.get(socket.ws)?.native.abortSignal.aborted)
        socket.ws.close(code, reason);
    }),
  serializeAttachment: (value) => socketAttachment(socket).write(value),
  deserializeAttachment: <T>() => socketAttachment(socket).read() as T | null,
});

const connections = new WeakMap<
  object,
  { connection: RivetConnection; native: RivetActorContext }
>();
const socketAttachment = (socket: WebSocket) => {
  const connection = connections.get(socket.ws);
  if (!connection)
    throw new Error("Rivet RPC socket has no native connection state");
  return connectionAttachment(connection.connection);
};

/** Register native state before delivering a fresh or reawakened socket. @internal */
export const registerConnection = (
  socket: WebSocket,
  connection: RivetConnection,
  native: RivetActorContext,
) => {
  connections.set(socket.ws, { connection, native });
};

/** Allocate before connection publication so dormant sockets cannot collide. @internal */
export const allocateClientId = NativeContext.pipe(
  Effect.flatMap((native) =>
    Effect.gen(function* () {
      const id = yield* Effect.sync(() => {
        const next = native.state.rpcNextClientId ?? 0;
        if (
          !Number.isSafeInteger(next) ||
          next < 0 ||
          next >= Number.MAX_SAFE_INTEGER
        ) {
          throw new Error("Rivet RPC connection identifiers exhausted");
        }
        native.state.rpcNextClientId = next + 1;
        return next;
      });
      yield* Effect.promise(() => native.saveState({ immediate: true }));
      return id;
    }),
  ),
);

/** Raw native WebSockets carry chunks incrementally; no HTTP/action buffering. @internal */
export const make = Effect.gen(function* () {
  const state = yield* DurableObjectState;
  const sockets = state
    .getWebSockets(RpcWebSocket.socketTag)
    .pipe(Effect.map((sockets) => sockets.map(protocolSocket)));
  const transport = yield* RpcWebSocket.make({
    sockets,
    allocateClientId,
    waitUntil: (effect) =>
      Effect.gen(function* () {
        const native = yield* NativeContext;
        const context = yield* Effect.context<RuntimeContext>();
        yield* Effect.sync(() =>
          native.waitUntil(
            native.keepAwake(
              Effect.runPromise(effect.pipe(Effect.provide(context))),
            ),
          ),
        );
      }),
    flush: () =>
      NativeContext.pipe(
        Effect.flatMap((native) =>
          Effect.promise(() => native.saveState({ immediate: true })),
        ),
      ),
    abort: (reason) => Effect.die(new Error(reason)),
  });
  return {
    ...transport,
    accept: (socket: WebSocket) =>
      Effect.gen(function* () {
        yield* state.setWebSocketTags(socket, [RpcWebSocket.socketTag]);
        return yield* transport.accept(protocolSocket(socket));
      }),
    webSocketMessage: (socket: WebSocket, message: string | ArrayBuffer) =>
      transport.webSocketMessage(protocolSocket(socket), message),
    webSocketClose: (socket: WebSocket) =>
      transport.webSocketClose(protocolSocket(socket)),
    webSocketError: (socket: WebSocket, error: unknown) =>
      transport.webSocketError(protocolSocket(socket), error),
  };
});
