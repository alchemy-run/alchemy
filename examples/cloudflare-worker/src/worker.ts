import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const Bucket = Cloudflare.R2Bucket("Bucket");

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.path },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket.bind(Bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = request.url.split("/").pop()!;

        if (request.method === "PUT") {
          yield* bucket.put(key, request.stream, {
            contentLength: Number(request.headers["content-length"] ?? 0),
          });
          return HttpServerResponse.empty({ status: 201 });
        }

        const object = yield* bucket.get(key);
        if (object === null) {
          return HttpServerResponse.text("Not found", { status: 404 });
        }
        const text = yield* object.text();
        return HttpServerResponse.text(text);
      }).pipe(
        Effect.catchTag("R2Error", (error) =>
          Effect.succeed(
            HttpServerResponse.text(error.message, { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.R2BucketBindingLive)),
);
