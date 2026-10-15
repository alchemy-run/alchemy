import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare";
import { BuildSecretsObject } from "./object.ts";

export default class BuildSecretsWorker extends Cloudflare.Worker<BuildSecretsWorker>()(
  "BuildSecretsWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* BuildSecretsObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/page") {
          const text = yield* objects.getByName("default").page();
          return HttpServerResponse.text(text);
        }

        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catchTag("HttpClientError", (err) =>
          Effect.succeed(HttpServerResponse.text(err.message, { status: 500 })),
        ),
      ),
    };
  }),
) {}
