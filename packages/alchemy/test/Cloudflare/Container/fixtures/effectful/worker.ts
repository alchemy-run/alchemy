import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Object } from "./object.ts";

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const objects = yield* Object;

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
);
