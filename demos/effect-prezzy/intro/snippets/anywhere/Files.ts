import type * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import { R2 } from "alchemy/Cloudflare";
import * as Storage from "alchemy/GCP/Storage";

const GCP = { Storage };
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class Files extends Context.Service<
  Files,
  { upload(name: string, body: string): Effect.Effect<void, never, Alchemy.RuntimeContext> }
>()("Files") {}

// #region show
export const FilesR2 = Layer.effect(
  Files,
  Effect.gen(function* () {
    const bucket = yield* R2.ReadWriteBucket(yield* R2.Bucket("Files"));
    return { upload: (name, body) => bucket.put(name, body)/*hide*/.pipe(Effect.asVoid, Effect.orDie)/*end*/ };
  }),
).pipe(Layer.provide(R2.ReadWriteBucketBinding));

export const FilesS3 = Layer.effect(
  Files,
  Effect.gen(function* () {
    const putObject = yield* AWS.S3.PutObject(yield* AWS.S3.Bucket("Files"));
    return { upload: (name, body) => putObject({ Key: name, Body: body })/*hide*/.pipe(Effect.asVoid, Effect.orDie)/*end*/ };
  }),
).pipe(Layer.provide(AWS.S3.PutObjectHttp));

export const FilesGCS = Layer.effect(
  Files,
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.WriteBucket(yield* GCP.Storage.Bucket("Files", {}));
    return { upload: (name, body) => bucket.put(name, body)/*hide*/.pipe(Effect.asVoid, Effect.orDie)/*end*/ };
  }),
).pipe(Layer.provide(GCP.Storage.WriteBucketHttp));
// #endregion show
