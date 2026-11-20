import * as Boat from "@alchemy.run/boat";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * A sandbox that runs an Effect program: it reads its environment, writes
 * to its own disk, and lists sandboxes through a binding.
 */
export default class Agent extends Boat.Sandbox<Agent>()(
  "Agent",
  {
    main: import.meta.url,
    type: "small",
    noEnv: true,
    env: { GREETING: "hello-from-boat" },
  },
  Effect.gen(function* () {
    const sandboxes = yield* Boat.CreateSandbox();
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://agent");
        if (url.pathname === "/disk") {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString("/home/user/marker.txt", "written-by-agent");
          return yield* HttpServerResponse.json({
            marker: yield* fs.readFileString("/home/user/marker.txt"),
          });
        }
        if (url.pathname === "/sandboxes") {
          const listed = yield* sandboxes.list({ labels: { "alchemy.id": "Agent" } });
          return yield* HttpServerResponse.json({ ids: listed.map((sandbox) => sandbox.id) });
        }
        const greeting = yield* Config.String("GREETING");
        const node = yield* Effect.sync(() => process.version);
        return yield* HttpServerResponse.json({ greeting, node });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Boat.CreateSandboxHttp)),
) {}
