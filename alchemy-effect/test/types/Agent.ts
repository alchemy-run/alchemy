import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as Socket from "effect/unstable/socket/Socket";
import { Sandbox } from "./Sandbox.ts";

const _agentEff = Effect.gen(function* () {
  const agent1 = yield* Agent;
  const _binding1 = yield* agent1.getByName("");
  _binding1.getProfile();
  const agent2 = yield* Agent2;
  const _binding2 = yield* agent2.getByName("");
  _binding2.getProfile();
  const agent3 = yield* Agent3;
  const _binding3 = yield* agent3.getByName("");
  _binding3.getProfile();
});

const _gen = Effect.gen(function* () {
  // bind the Sandbox Container to the Agent DO
  const sandbox = yield* Cloudflare.bindContainer(Sandbox);

  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    // get the container instance
    const container = yield* Cloudflare.runContainer(sandbox);

    container.getTcpPort(1080);
    container.getUser();

    return {
      getProfile: () => state.storage.get<string>("Profile"),
    };
  });
});

export const Agent2 = Cloudflare.DurableObjectNamespace(
  "Agents",
  Effect.gen(function* () {
    // bind the Sandbox Container to the Agent DO
    const sandbox = yield* Cloudflare.bindContainer(Sandbox);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      // get the container instance
      const container = yield* Cloudflare.runContainer(sandbox);

      container.getTcpPort(1080);
      container.getUser();

      return {
        getProfile: () => state.storage.get<string>("Profile"),
      };
    });
  }),
);

export class Agent3 extends Cloudflare.DurableObjectNamespace<Agent3>()(
  "Agents",
  Effect.gen(function* () {
    // bind the Sandbox Container to the Agent DO
    const sandbox = yield* Cloudflare.bindContainer(Sandbox);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      // get the container instance
      const container = yield* Cloudflare.runContainer(sandbox);

      container.getTcpPort(1080);
      container.getUser();

      return {
        getProfile: () => state.storage.get<string>("Profile"),
      };
    });
  }),
) {}

export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    // bind the Sandbox Container to the Agent DO
    const sandbox = yield* Cloudflare.bindContainer(Sandbox);

    return Effect.gen(function* () {
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
        getProfile: () => state.storage.get<string>("Profile"),
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
  }),
) {}
