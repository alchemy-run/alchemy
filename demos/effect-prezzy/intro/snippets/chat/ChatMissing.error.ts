import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { DatabaseLive } from "./Db.ts";
import { FilesLive } from "./Files.ts";
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
  }).pipe(
    Effect.provide(
      RoomsLive.pipe(
        Layer.provide([DatabaseLive, FilesLive]),
      ),
    ),
  ),
);
// #endregion show
