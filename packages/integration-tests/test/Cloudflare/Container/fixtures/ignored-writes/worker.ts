import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { IgnoredWritesObject } from "./object.ts";

/** `GET /<file>` proxies to the container's httpd via the DO. */
export default class IgnoredWritesWorker extends Cloudflare.Worker<IgnoredWritesWorker>()(
  "IgnoredWritesWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* IgnoredWritesObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const text = yield* objects
          .getByName("default")
          .read(url.pathname)
          .pipe(Effect.catchCause((cause) => Effect.succeed(`CONTAINER_UNREACHABLE: ${cause}`)));
        return HttpServerResponse.text(text);
      }),
    };
  }),
) {}
