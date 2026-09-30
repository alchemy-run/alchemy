import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Rooms, RoomsLive } from "./Rooms.ts";

// #region show
export default Cloudflare.Worker(
  "Chat",
  { main: import.meta.url },
  Effect.gen(function* () {
    const rooms = yield* Rooms;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, room, file] = request.url.split("/");
        if (route === "join") return yield* rooms.join(room!, request);
        if (route === "attach") {
          yield* rooms.attach(room!, file!, yield* request.text);
          return HttpServerResponse.empty({ status: 201 });
        }
        return yield* HttpServerResponse.json(yield* rooms.history(room!));
      })/*hide*/.pipe(Effect.orDie)/*end*/,
    };
  }).pipe(Effect.provide(RoomsLive)),
);
// #endregion show
