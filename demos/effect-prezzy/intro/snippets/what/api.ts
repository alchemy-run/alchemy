import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// #region show
export const Uploads = Cloudflare.R2.Bucket("Uploads");

export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Uploads);

    return {
      fetch: Effect.gen(function* () {
        const obj = yield* bucket.get("hello.txt");
        return obj
          ? HttpServerResponse.text(yield* obj.text())
          : HttpServerResponse.text("Not found", { status: 404 });
      }) /*hide*/
        .pipe(Effect.orDie) /*end*/,
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
);
// #endregion show
