import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const Bucket = Cloudflare.R2Bucket("bucket");

export default Cloudflare.Worker(
  "api",
  { main: import.meta.path },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket.bind(Bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const object = yield* bucket.get(request.url);
        return HttpServerResponse.stream(object!.body);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.R2BucketBindingLive)),
);
