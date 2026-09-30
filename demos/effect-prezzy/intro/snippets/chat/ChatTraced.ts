import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { DatabaseLive } from "./Db.ts";
import { FilesR2 } from "./Files.ts";
import { HistoryLive } from "./History.ts";
import { Ingest, Logs, Traces } from "./Telemetry.ts";
import { RoomLive } from "./Room.ts";
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
    Effect.provide([
      RoomsLive.pipe(
        Layer.provide(RoomLive),
        Layer.provide(HistoryLive),
        Layer.provide([DatabaseLive, FilesR2]),
      ),
      Axiom.Telemetry({ token: Ingest, traces: Traces, logs: Logs }),
    ]),
  ),
);
// #endregion show
