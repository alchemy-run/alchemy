import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare";
import { HarnessObject } from "./object.ts";

export default class HarnessWorker extends Cloudflare.Worker<HarnessWorker>()(
  "HarnessWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* HarnessObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const session = url.searchParams.get("session") ?? "default";
        const object = objects.getByName(url.searchParams.get("object") ?? "default");
        if (url.pathname === "/turn") {
          return HttpServerResponse.text(
            yield* object.turn(session, url.searchParams.get("prompt") ?? ""),
          );
        }
        if (url.pathname === "/stop") {
          yield* object.stop();
          return HttpServerResponse.text("stopped");
        }
        if (url.pathname === "/read") {
          return HttpServerResponse.text(yield* object.read(url.searchParams.get("path") ?? ""));
        }
        if (url.pathname === "/crash") {
          yield* object.crash();
          return HttpServerResponse.text("crashed");
        }
        if (url.pathname === "/turns") {
          return HttpServerResponse.text(String(yield* object.completedTurns(session)));
        }
        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
