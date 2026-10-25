import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** A force-destroyable bucket the Worker leaves an incomplete multipart upload in. */
export const MultipartBucket = Cloudflare.R2.Bucket("MultipartUploadBucket", {
  forceDestroy: true,
});

/**
 * `POST /start-upload?key=` starts a multipart upload, uploads one part, and
 * never completes it — the upload stays in the bucket.
 * `POST /abort-upload?key=&uploadId=` aborts it.
 */
export default class MultipartWorker extends Cloudflare.Worker<MultipartWorker>()(
  "R2MultipartWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2.WriteBucket(MultipartBucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (request.method === "POST" && url.pathname === "/start-upload") {
          const key = url.searchParams.get("key") ?? "";
          const upload = yield* r2.createMultipartUpload(key).pipe(Effect.orDie);
          yield* upload.uploadPart(1, "part").pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ uploadId: upload.uploadId });
        }
        if (request.method === "POST" && url.pathname === "/abort-upload") {
          const key = url.searchParams.get("key") ?? "";
          const uploadId = url.searchParams.get("uploadId") ?? "";
          const upload = yield* r2.resumeMultipartUpload(key, uploadId).pipe(Effect.orDie);
          yield* upload.abort().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ aborted: true });
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.WriteBucketBinding)),
) {}
