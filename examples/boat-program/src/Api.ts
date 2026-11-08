// src/Api.ts
import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * An Effect program served from a Boat sandbox at a public URL. It counts
 * visits in a file on the sandbox's disk, which Boat keeps across stops.
 */
export default class Api extends Boat.Sandbox<Api>()(
  "Api",
  { main: import.meta.url, type: "small", noEnv: true, public: true },
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = "/home/user/visits.txt";
    return {
      fetch: Effect.gen(function* () {
        const previous = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "0"));
        const visits = Number(previous) + 1;
        yield* fs.writeFileString(file, String(visits));
        return yield* HttpServerResponse.json({ visits });
      }).pipe(Effect.orDie),
    };
  }),
) {}
