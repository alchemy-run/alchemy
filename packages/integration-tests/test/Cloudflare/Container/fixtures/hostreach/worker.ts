import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HostReachContainerObject, StartEnvContainerObject } from "./object.ts";

export default class HostReachContainerWorker extends Cloudflare.Worker<HostReachContainerWorker>()(
  "HostReachContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* HostReachContainerObject;
    const startEnvObjects = yield* StartEnvContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const object = objects.getByName("default");

        if (url.pathname === "/env") {
          return HttpServerResponse.text(yield* object.getEnv());
        }
        if (url.pathname === "/probe") {
          return HttpServerResponse.text(yield* object.getProbe());
        }
        if (url.pathname === "/start-env-probe") {
          return HttpServerResponse.text(yield* startEnvObjects.getByName("default").getProbe());
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
