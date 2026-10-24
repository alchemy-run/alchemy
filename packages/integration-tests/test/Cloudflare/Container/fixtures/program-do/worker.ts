import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ProgramBoxObject } from "./object.ts";

export default class ProgramBoxWorker extends Cloudflare.Worker<ProgramBoxWorker>()(
  "ProgramBoxWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* ProgramBoxObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/write-read") {
          return HttpServerResponse.text(yield* objects.getByName("write").writeAndRead("hello"));
        }
        if (url.pathname === "/memory") {
          const size = url.searchParams.get("size") === "large" ? "large" : "small";
          return HttpServerResponse.text(
            String(yield* objects.getByName(`memory-${size}`).memoryAt(size)),
          );
        }
        if (url.pathname === "/snapshot") {
          return yield* HttpServerResponse.json(
            yield* objects.getByName("snapshot").snapshotRoundTrip("persisted"),
          );
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
