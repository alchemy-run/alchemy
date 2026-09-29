import * as Cloudflare from "alchemy/Cloudflare";
import { R2 } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Room from "./Room.ts";

// #region show
export default Cloudflare.Worker(
  "Chat",
  { main: import.meta.url },
  Effect.gen(function* () {
    // #region rooms
    const rooms = yield* Room;
    // #endregion rooms
    // #region files
    const bucket = yield* R2.Bucket("Files");
    const files = yield* R2.ReadBucket(bucket);
    // #endregion files

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, name] = request.url.split("/");
        // #region route
        if (route === "rooms") {
          return yield* rooms.getByName(name!).fetch(request);
        }
        // #endregion route
        // #region upload
        if (route === "files") {
          yield* files.put(name!, yield* request.text);
          return HttpServerResponse.empty({ status: 201 });
        }
        // #endregion upload
        return HttpServerResponse.text("hello");
      })/*hide*/.pipe(Effect.orDie)/*end*/,
    };
  })/*hide*/.pipe(Effect.provide(R2.ReadBucketBinding))/*end*/,
);
// #endregion show
