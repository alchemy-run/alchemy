import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as Socket from "effect/unstable/socket/Socket";

export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    // bind the Sandbox Container to the Agent DO
    // const sandbox = yield* Cloudflare.bindContainer(Sandbox);

    // return an Effect that will be un once per instance of a Durable Object
    const eff = Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      // get the container instance
      const container = yield* Cloudflare.runContainer(sandbox);

      const connection = yield* container.getTcpPort(1080);

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
        getProfile: () => Effect.succeed("TODO"),
        putProfile: Effect.fnUntraced(function* (value: string) {
          yield* state.storage.put("Profile", value);
        }),
        eval: (code: string) =>
          connection
            .fetch(
              HttpClientRequest.post("/eval", {
                body: HttpBody.text(code),
              }),
            )
            .pipe(
              Effect.flatMap((response) => response.text),
              Effect.orDie,
            ),
        // http (websocket connections)
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const [response, socket] = yield* Cloudflare.upgrade(request);
          const id = "TODO";
          yield* socket.serializeAttachment({ id });
          sessions.set(id, {
            socket,
            write: yield* socket.writer,
          });

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

    return Effect.gen(function* () {
      return {
        getProfile: () => Effect.succeed("BOOF"),
        getStream: () =>
          Effect.succeed(
            Stream.forever(
              Stream.fromEffect(
                (() => {
                  let i = 0;
                  return Effect.sync(() => i++);
                })(),
              ),
            ),
          ),
      };
    });
  }),
) {}
