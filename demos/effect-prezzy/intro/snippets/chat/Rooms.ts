import type * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { UploadError } from "./Files.ts";
import { History, HistoryLive } from "./History.ts";
import Room from "./Room.ts";

// #region show
// #region service
export class Rooms extends Context.Service<
  Rooms,
  {
    join(room: string, request: HttpServerRequest): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Alchemy.RuntimeContext>;
    attach(room: string, file: string, body: string): Effect.Effect<void, UploadError, Alchemy.RuntimeContext>;
    history(room: string): Effect.Effect<readonly string[], never, Alchemy.RuntimeContext>;
  }
>()("Rooms") {}
// #endregion service
// #region live

export const RoomsLive = Layer.effect(
  Rooms,
  Effect.gen(function* () {
    const room = yield* Room;
    const history = yield* History;

    return {
      join: (name: string, request: HttpServerRequest) => room.getByName(name).fetch(request)/*hide*/.pipe(Effect.orDie)/*end*/,
      attach: history.attach,
      history: history.list,
    };
  }),
).pipe(Layer.provide(HistoryLive));
// #endregion live
// #endregion show
