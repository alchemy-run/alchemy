import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class S3PresignTestFunction extends Lambda.Function<S3PresignTestFunction>()(
  "S3PresignTestFunction",
) {}

export default S3PresignTestFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("PresignBucket", {
      forceDestroy: true,
    });

    const presignGetObject = yield* S3.PresignGetObject(bucket);
    const presignPutObject = yield* S3.PresignPutObject(bucket);
    const BucketName = yield* bucket.bucketName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // The first event after a cold start can observe not-yet-hydrated
        // resource Outputs (they resolve to `undefined` until the runtime
        // finishes hydrating resource state). Answer 503 so callers retry
        // instead of receiving presigned URLs for a bucket named
        // "undefined".
        const bucketName = yield* BucketName;
        if (!bucketName) {
          return HttpServerResponse.text("Outputs not hydrated yet", {
            status: 503,
          });
        }

        if (request.method === "GET" && pathname === "/bucket-name") {
          return yield* HttpServerResponse.json({ bucketName });
        }

        if (request.method === "GET" && pathname === "/presign-get") {
          const key = url.searchParams.get("key");
          if (!key) {
            return HttpServerResponse.text("Missing key", { status: 400 });
          }
          const expiresIn = url.searchParams.get("expiresIn");
          const contentType = url.searchParams.get("contentType");
          const presignedUrl = yield* presignGetObject({
            key,
            expiresIn: expiresIn ? Number(expiresIn) : undefined,
            contentType: contentType ?? undefined,
          });
          return yield* HttpServerResponse.json({ url: presignedUrl });
        }

        if (request.method === "GET" && pathname === "/presign-put") {
          const key = url.searchParams.get("key");
          if (!key) {
            return HttpServerResponse.text("Missing key", { status: 400 });
          }
          const expiresIn = url.searchParams.get("expiresIn");
          const contentType = url.searchParams.get("contentType");
          const presignedUrl = yield* presignPutObject({
            key,
            expiresIn: expiresIn ? Number(expiresIn) : undefined,
            contentType: contentType ?? undefined,
          });
          return yield* HttpServerResponse.json({ url: presignedUrl });
        }

        return yield* HttpServerResponse.json(
          {
            error: "Not found",
            method: request.method,
            pathname,
          },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(S3.PresignGetObjectHttp, S3.PresignPutObjectHttp),
    ),
  ),
);
