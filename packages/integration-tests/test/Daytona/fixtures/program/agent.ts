import * as Daytona from "@alchemy.run/daytona";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { PROGRAM_PORT, ProgramData } from "./shared.ts";

/**
 * A sandbox that runs an Effect program: it reads its environment, writes
 * to a volume it mounts through MountVolume, and serves both.
 */
export default class Agent extends Daytona.Sandbox<Agent>()(
  "Agent",
  {
    main: import.meta.url,
    port: PROGRAM_PORT,
    public: true,
    env: { GREETING: "hello-from-daytona" },
  },
  Effect.gen(function* () {
    const data = yield* Daytona.MountVolume(ProgramData, { path: "/data" });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://agent");
        const fs = yield* FileSystem.FileSystem;
        if (url.pathname === "/data") {
          yield* fs.writeFileString(`${data.path}/marker.txt`, "written-by-agent");
          const files = yield* fs.readDirectory(data.path);
          return yield* HttpServerResponse.json({ path: data.path, files: files.sort() });
        }
        const greeting = yield* Config.String("GREETING");
        const node = yield* Effect.sync(() => process.version);
        return yield* HttpServerResponse.json({ greeting, node });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Daytona.MountVolumeLive)),
) {}
