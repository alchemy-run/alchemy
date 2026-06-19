import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { EffectfulContainerObject } from "./object.ts";

export default class EffectfulContainerWorker extends Cloudflare.Worker<EffectfulContainerWorker>()(
  "EffectfulContainerWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const objects = yield* EffectfulContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/ping") {
          const pong = yield* objects.getByName("default").ping();
          return HttpServerResponse.text(pong);
        }

        if (url.pathname === "/hello") {
          const text = yield* objects
            .getByName("default")
            .hello()
            .pipe(Effect.orDie);
          return HttpServerResponse.text(text);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
