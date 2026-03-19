// @ts-nocheck
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

export const Agent = Cloudflare.DurableObjectNamespace(
  "Users",
  Effect.gen(function* () {
    // bind the Sandbox Container to the Agent DO
    const sandbox = yield* Sandbox;

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      const sessions = new Map<
        string,
        {
          socket: Cloudflare.DurableWebSocket;
          write: (
            chunk: Uint8Array | string,
          ) => Effect.Effect<void, Socket.SocketError>;
        }
      >();

      // restore hibernated web sockets
      for (const socket of yield* state.getWebSockets()) {
        const session = yield* socket.deserializeAttachment<{ id: string }>();
        if (session) {
          sessions.set(session.id, {
            socket,
            write: yield* socket.writer,
          });
        }
      }

      return {
        // rpc
        getProfile: () => state.storage.get<string>("Profile"),
        putProfile: Effect.fnUntraced(function* (value: string) {
          yield* state.storage.put("Profile", value);
        }),
        // http (websocket connections)
        fetch: Effect.gen(function* () {
          // HttpEffect
          const request = yield* HttpServerRequest;

          // Deferred
          // promise = Effect.runPromise(Deferred.await(deferred))
          // ctx.waitUntil(promise)

          // new Response(null, { status: 101, webSocket: client })
          // const socket = yield* request.upgrade; // footgun, must die

          // yielding this return new Response(null, { status: 101, webSocket: client })
          // forces you to use hibernation

          const [response, socket] = yield* Cloudflare.upgrade(request);

          // TODO(sam): can you write to the socket from ctx.waitUntil?

          // will this wake back up? this is not guaranteed to run in the case where th DO is hibernated.
          const id = "TODO";
          yield* socket.serializeAttachment({ id });
          sessions.set(id, {
            socket,
            write: yield* socket.writer,
          });

          const container = yield* sandbox.getInstance(id);

          return response;
        }),
        // maybe have a WebSocketEffect type?
        webSocketMessage: Effect.fnUntraced(function* (
          socket: Cloudflare.DurableWebSocket,
          message: string | Uint8Array,
        ) {
          const session = yield* socket.deserializeAttachment<{ id: string }>();
          if (!session) return;
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          for (const peer of sessions.values()) {
            yield* peer.write(`[${session.id}] ${text}`);
          }
        }),
        webSocketClose: Effect.fnUntraced(function* (
          ws: Cloudflare.DurableWebSocket,
          code: number,
          reason: string,
          _wasClean: boolean,
        ) {
          const session = yield* ws.deserializeAttachment<{ id: string }>();
          if (session) {
            sessions.delete(session.id);
          }
          // Required by Cloudflare to complete the close handshake.
          yield* ws.close(code, reason);
        }),
      };
    });
  }),
);
