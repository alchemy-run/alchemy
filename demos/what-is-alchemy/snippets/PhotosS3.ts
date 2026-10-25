import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Photos } from "./Photos.ts";

// #region show
export const PhotosS3 = Layer.effect(
  Photos,
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("Photos");
    const photos = yield* AWS.S3.PutObject(bucket);
    return {
      upload: (name: string, body: string) =>
        photos({ Key: name, Body: body }) /*hide*/.pipe(Effect.asVoid, Effect.orDie) /*end*/,
    };
  }),
) /*hide*/.pipe(Layer.provide(AWS.S3.PutObjectHttp)) /*end*/;
// #endregion show
