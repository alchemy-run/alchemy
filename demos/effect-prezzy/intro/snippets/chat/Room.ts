import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import { History } from "./History.ts";

type RoomShape = {
  fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Cloudflare.DurableObjectState | RuntimeContext>;
  webSocketMessage: (socket: Cloudflare.WebSocket, text: string) => Effect.Effect<void, never, RuntimeContext>;
};

// #region show
export class Room extends Cloudflare.DurableObject<Room, RoomShape>()("Room") {}

export const RoomLive = Room.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // #region history
    const history = yield* History;
    // #endregion history

    return Effect.gen(function* () {
      return {
        // #region connect
        fetch: Effect.gen(function* () {
          const [response] = yield* Cloudflare.upgrade();
          return response;
        }),
        // #endregion connect
        // #region message
        webSocketMessage: Effect.fn(function* (_from, text) {
          // #region broadcast
          for (const socket of yield* state.getWebSockets()) {
            yield* socket.send(text);
          }
          // #endregion broadcast
          // #region send
          yield* history.append(state.id.name!, text);
          // #endregion send
        }),
        // #endregion message
      };
    });
  }),
);
// #endregion show
