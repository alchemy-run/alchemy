import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare";
import { ExternalContainerObject } from "./object.ts";

// Report failures in the response body, so a test that times out waiting
// for the container shows why instead of a bare 500.
const reportFailure = Effect.catchCause((cause: Cause.Cause<unknown>) =>
  Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
);

export default class ExternalContainerWorker extends Cloudflare.Worker<ExternalContainerWorker>()(
  "ExternalContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* ExternalContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/hello") {
          const text = yield* objects.getByName("default").hello().pipe(Effect.orDie);
          return HttpServerResponse.text(text);
        }

        return HttpServerResponse.text("ok");
      }).pipe(reportFailure),
    };
  }),
) {}
