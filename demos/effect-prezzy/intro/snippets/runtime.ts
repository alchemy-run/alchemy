import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// #region show
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Uploads");
    const uploads = yield* Cloudflare.R2.ReadBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const object = yield* uploads.get("README.md");
        return HttpServerResponse.text(object ? "found" : "missing");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadBucketBinding)),
) {}
// #endregion show
