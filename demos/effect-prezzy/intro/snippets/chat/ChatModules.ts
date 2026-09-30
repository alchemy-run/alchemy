import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Files, FilesR2 } from "./Files.ts";
import { History, HistoryLive } from "./History.ts";
import Room from "./Room.ts";

// #region show
export default Cloudflare.Worker(
  "Chat",
  { main: import.meta.url },
  Effect.gen(function* () {
    const rooms = yield* Room;
    const files = yield* Files;
    const history = yield* History;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, name] = request.url.split("/");
        if (route === "rooms") return yield* rooms.getByName(name!).fetch(request);
        if (route === "files") {
          yield* files.upload(name!, yield* request.text);
          return HttpServerResponse.empty({ status: 201 });
        }
        return yield* HttpServerResponse.json(yield* history.list(name!));
      })/*hide*/.pipe(Effect.orDie)/*end*/,
    };
  }).pipe(Effect.provide([FilesR2, HistoryLive])),
);
// #endregion show
