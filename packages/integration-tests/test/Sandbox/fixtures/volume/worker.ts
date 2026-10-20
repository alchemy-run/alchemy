import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { VolumeObject } from "./object.ts";

/** POST /<op> with a JSON body; answers JSON. */
export default class VolumeWorker extends Cloudflare.Worker<VolumeWorker>()(
  "VolumeWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* VolumeObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const op = new URL(request.url, "http://x").pathname.slice(1);
        const body = (yield* request.json) as Record<string, string>;
        const object = objects.getByName("volume");
        const result: unknown = yield* (() => {
          switch (op) {
            case "start":
              return Effect.as(object.start(), "started");
            case "stop":
              return Effect.as(object.stop(), "stopped");
            case "head":
              return object.head(body.head!);
            case "fork":
              return object.fork(body.to!, body.from);
            case "exec":
              return object.exec(body.head!, body.command!);
            case "history":
              return object.history(body.head!);
            case "reset":
              return Effect.as(object.reset(body.head!, body.snapshot!), "reset");
            case "drop":
              return Effect.as(object.drop(body.head!), "dropped");
            default:
              return Effect.succeed("ok");
          }
        })();
        return yield* HttpServerResponse.json({ result: result ?? null });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
