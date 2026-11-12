/**
 * A Durable Object that holds WebSockets: `fetch` accepts each with
 * `Rivet.upgrade()`, and every message is broadcast to the room.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { Default } from "./cluster.ts";

export default class SocketRoom extends Rivet.DurableObject<SocketRoom>()(
  "SocketRoom",
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const url = new URL(request.url, "http://actor");
          const user = url.searchParams.get("user") ?? "anonymous";
          const [response, socket] = yield* Rivet.upgrade({ tags: ["room"] });
          socket.serializeAttachment({ user });
          // What the socket arrived with: the caller's path and headers.
          yield* socket.send(
            JSON.stringify({
              welcome: user,
              path: url.pathname,
              header: request.headers["x-room"] ?? null,
            }),
          );
          return response;
        }),
        webSocketMessage: (socket: Rivet.WebSocket, message: string | Uint8Array) =>
          Effect.gen(function* () {
            const from = socket.deserializeAttachment<{ user: string }>()?.user;
            const text = typeof message === "string" ? message : new TextDecoder().decode(message);
            for (const peer of yield* state.getWebSockets("room")) {
              yield* peer.send(JSON.stringify({ from, text }));
            }
          }),
        webSocketClose: (socket: Rivet.WebSocket) => socket.close(1000, ""),
        /** How many sockets the room holds. */
        sockets: () => Effect.map(state.getWebSockets("room"), (sockets) => sockets.length),
      };
    });
  }).pipe(Effect.provide(Default)),
) {}
