import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// #region show
// #region service
export class Photos extends Context.Service<
  Photos,
  { upload(name: string, body: string): Effect.Effect<void, never, Alchemy.RuntimeContext> }
>()("Photos") {}
// #endregion service

export const PhotosR2 = Layer.effect(
  Photos,
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Photos");
    const photos = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    return {
      upload: (name: string, body: string) =>
        photos.put(name, body) /*hide*/.pipe(Effect.asVoid, Effect.orDie) /*end*/,
    };
  }),
) /*hide*/
  .pipe(Layer.provide(Cloudflare.R2.ReadWriteBucketBinding)); /*end*/
// #endregion show
