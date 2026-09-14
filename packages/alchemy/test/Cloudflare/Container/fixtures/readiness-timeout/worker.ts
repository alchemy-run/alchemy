import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TimeoutContainerObject } from "./object.ts";

/** Surfaces the real container readiness deadline as an HTTP response. */
export default class TimeoutContainerWorker extends Cloudflare.Worker<TimeoutContainerWorker>()(
  "TimeoutContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* TimeoutContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/hello") {
          const text = yield* objects.getByName("default").hello();
          return HttpServerResponse.text(text);
        }

        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(String(cause), { status: 503 }),
          ),
        ),
      ),
    };
  }),
) {}
