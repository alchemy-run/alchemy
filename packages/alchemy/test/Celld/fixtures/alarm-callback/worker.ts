import { Worker } from "@/Celld/Worker.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { AlarmObject } from "./object.ts";

export default class AlarmWorker extends Worker<AlarmWorker>()(
  "AlarmWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* AlarmObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(
          () => new URL(request.url, "http://callback"),
        );
        const [name, operation = "snapshot"] = url.pathname
          .split("/")
          .filter(Boolean);
        if (!name) return HttpServerResponse.text("Not Found", { status: 404 });
        const object = objects.getByName(name);
        if (operation === "clear") {
          yield* object.clear();
          return yield* HttpServerResponse.json({ cleared: true });
        }
        if (operation === "seed")
          yield* object.seed(url.searchParams.get("mode") ?? "atomic");
        if (operation === "late")
          return yield* HttpServerResponse.json(yield* object.late());
        if (operation === "probe")
          return yield* HttpServerResponse.json(
            yield* object.probe(url.searchParams.get("kind") ?? "rollback"),
          );
        if (operation === "cancel-legacy-repeat")
          yield* object.cancelLegacyRepeat();
        return yield* HttpServerResponse.json(yield* object.snapshot());
      }).pipe(Effect.orDie),
    };
  }),
) {}
