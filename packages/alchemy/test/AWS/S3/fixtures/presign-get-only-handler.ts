import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as S3Api from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class PresignGetOnlyTestFunction extends Lambda.Function<PresignGetOnlyTestFunction>()(
  "PresignGetOnlyTestFunction",
) {}

export default PresignGetOnlyTestFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("PresignGetOnlyBucket", {
      forceDestroy: true,
      versioning: "Enabled",
    });
    const getObject = yield* S3Api.getObject;
    const presignGet = yield* S3.PresignGetObject(bucket);
    const bucketName = yield* bucket.bucketName;
    const bucketArn = yield* bucket.bucketArn;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.originalUrl));
        if (url.pathname === "/info") {
          return yield* HttpServerResponse.json({
            bucketName: yield* bucketName,
            bucketArn: yield* bucketArn,
          });
        }
        const key = url.searchParams.get("key");
        if (!key)
          return HttpServerResponse.text("Missing key", { status: 400 });
        if (url.pathname === "/version") {
          return yield* getObject({
            Bucket: yield* bucketName,
            Key: key,
            VersionId: url.searchParams.get("versionId") ?? undefined,
          }).pipe(
            Effect.as(HttpServerResponse.text("Unexpected version access")),
            Effect.catchTag("AccessDeniedException", (error) =>
              HttpServerResponse.json({ tag: error._tag }, { status: 403 }),
            ),
          );
        }
        return yield* HttpServerResponse.json({
          url: yield* presignGet({ key }),
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(S3.PresignGetObjectHttp)),
);
