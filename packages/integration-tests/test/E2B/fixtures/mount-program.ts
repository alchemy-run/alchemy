import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SharedVolume } from "./resources.ts";

/** A template program that mounts the shared volume and lists it. */
export default class MountProgram extends E2B.Template<MountProgram>()(
  "MountProgram",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const shared = yield* E2B.MountVolume(SharedVolume, { path: "/shared" });
    const fs = yield* FileSystem;
    return {
      fetch: Effect.gen(function* () {
        const files = yield* fs.readDirectory(shared.path);
        return yield* HttpServerResponse.json({ path: shared.path, files });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(E2B.MountVolumeLive)),
) {}
