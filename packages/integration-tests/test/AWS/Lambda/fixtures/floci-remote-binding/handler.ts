import * as Lambda from "@alchemy.run/aws/Lambda";
import * as S3 from "@alchemy.run/aws/S3";
import * as Alchemy from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/**
 * A Lambda emulated by floci under `alchemy dev` whose bucket is pinned to
 * the real cloud with `Alchemy.remote()`: its PutObject/GetObject calls must
 * reach real S3, not the emulator.
 */
export class RemoteBindingFunction extends Lambda.Function<RemoteBindingFunction>()(
  "RemoteBindingFunction",
) {}

export default RemoteBindingFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("RemoteBindingBucket", { forceDestroy: true }).pipe(
      Alchemy.remote(),
    );
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    const bucketName = yield* bucket.bucketName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.originalUrl));
        if (url.pathname === "/info") {
          return yield* HttpServerResponse.json({ bucketName: yield* bucketName });
        }
        const key = url.searchParams.get("key");
        if (!key) return HttpServerResponse.text("Missing key", { status: 400 });
        if (url.pathname === "/put") {
          yield* putObject({ Key: key, Body: url.searchParams.get("value") ?? "" });
          return HttpServerResponse.text("ok");
        }
        const object = yield* getObject({ Key: key });
        return HttpServerResponse.text(yield* Stream.mkString(Stream.decodeText(object.Body!)));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(S3.PutObjectHttp, S3.GetObjectHttp))),
);
