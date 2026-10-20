import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { INTERCEPT_HOST, InterceptContainerObject } from "./object.ts";

export default class InterceptContainerWorker extends Cloudflare.Worker<InterceptContainerWorker>()(
  "InterceptContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* InterceptContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        // Intercepted container traffic delivered to this entrypoint.
        if (request.headers.host === INTERCEPT_HOST) {
          return HttpServerResponse.text(`entrypoint ${request.headers.host}${url.pathname}`);
        }
        if (url.pathname === "/probe/entrypoint") {
          return HttpServerResponse.text(yield* objects.getByName("entrypoint").probeEntrypoint());
        }
        if (url.pathname === "/probe/egress") {
          return HttpServerResponse.text(yield* objects.getByName("egress").probeEgress());
        }
        if (url.pathname === "/probe/https") {
          return HttpServerResponse.text(yield* objects.getByName("https").probeHttps());
        }
        // One object, and so one container, per interception mode.
        if (url.pathname === "/probe/host") {
          return HttpServerResponse.text(yield* objects.getByName("host").probeHost());
        }
        if (url.pathname === "/probe/all") {
          return HttpServerResponse.text(yield* objects.getByName("all").probeAll());
        }
        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catchTag("HttpClientError", (err) =>
          Effect.succeed(
            err.response
              ? HttpServerResponse.fromClientResponse(err.response)
              : HttpServerResponse.text(err.message, { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}
