import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare/index.ts";

export const HttpBucket = Cloudflare.R2.Bucket("HttpBindingBucket");

/** An Effect Worker using a token-scoped `*Http` binding on a local bucket. */
export default class HttpBindingWorker extends Cloudflare.Worker<HttpBindingWorker>()(
  "HttpBindingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* Cloudflare.R2.ReadWriteBucket(yield* HttpBucket);
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketHttp)),
) {}
