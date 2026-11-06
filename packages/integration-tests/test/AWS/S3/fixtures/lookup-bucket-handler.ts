import * as Lambda from "@alchemy.run/aws/Lambda";
import * as S3 from "@alchemy.run/aws/S3";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/**
 * Name of the bucket the lookup suite's target stack owns. A lookup's props
 * key its bindings, so the Function computes it from `yield* Stage`, which
 * resolves the same at deploy time and inside the deployed Function.
 */
export const lookupBucketName = (stage: string) =>
  `alchemy-lookup-${stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`
    .slice(0, 63)
    .replace(/-+$/, "");

export class LookupBucketFunction extends Lambda.Function<LookupBucketFunction>()(
  "LookupBucketFunction",
) {}

/**
 * Reads and writes objects in a bucket it looks up and never manages.
 */
export default LookupBucketFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const bucket = S3.Bucket.lookup({ bucketName: lookupBucketName(yield* Stage) });
    const getObject = yield* S3.GetObject(bucket);
    const putObject = yield* S3.PutObject(bucket);
    const bucketName = yield* bucket.bucketName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.originalUrl));
        const Key = url.searchParams.get("key");
        if (url.pathname === "/bucket") {
          return HttpServerResponse.text(yield* bucketName);
        }
        if (!Key) return HttpServerResponse.text("Missing key", { status: 400 });
        if (url.pathname === "/put") {
          yield* putObject({ Key, Body: yield* request.text });
          return HttpServerResponse.text("ok");
        }
        const result = yield* getObject({ Key });
        return HttpServerResponse.text(yield* Stream.mkString(Stream.decodeText(result.Body!)));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(S3.GetObjectHttp, S3.PutObjectHttp))),
);
