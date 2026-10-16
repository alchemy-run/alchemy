import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare";
import { MountObject } from "./object.ts";

export default class MountWorker extends Cloudflare.Worker<MountWorker>()(
  "MountWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* MountObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (!request.url.endsWith("/check")) return HttpServerResponse.text("ok");
        return HttpServerResponse.text(yield* objects.getByName("default").check());
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
