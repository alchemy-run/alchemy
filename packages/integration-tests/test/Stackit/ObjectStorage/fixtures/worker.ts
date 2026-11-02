import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export const Data = Stackit.ObjectStorage.Bucket("ObjectStorageBindingsData", {
  forceDestroy: true,
});

/**
 * A Cloudflare Worker with every bucket binding. One route per client operation;
 * each answers `{ ok, result | error }` so a failure surfaces the S3 error.
 */
export default class ObjectStorageBindingsWorker extends Cloudflare.Worker<ObjectStorageBindingsWorker>()(
  "StackitObjectStorageBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const data = yield* Data;
    const read = yield* Stackit.ObjectStorage.ReadBucket(data);
    const write = yield* Stackit.ObjectStorage.WriteBucket(data);
    const readWrite = yield* Stackit.ObjectStorage.ReadWriteBucket(data);
    const presignGet = yield* Stackit.ObjectStorage.PresignGetObject(data);
    const presignPut = yield* Stackit.ObjectStorage.PresignPutObject(data);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    const text = (object: { readonly Body?: Stream.Stream<Uint8Array, any> }) =>
      object.Body === undefined
        ? Effect.succeed("")
        : Stream.mkString(Stream.decodeText(object.Body));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const key = url.searchParams.get("key") ?? "";
        const body = url.searchParams.get("body") ?? "";
        switch (url.pathname) {
          case "/read/get":
            return yield* respond(read.getObject({ Key: key }).pipe(Effect.flatMap(text)));
          case "/read/head":
            return yield* respond(
              read
                .headObject({ Key: key })
                .pipe(Effect.map((head) => ({ contentLength: head.ContentLength }))),
            );
          case "/read/list":
            return yield* respond(
              read
                .listObjects({ Prefix: key })
                .pipe(Effect.map((listed) => (listed.Contents ?? []).map((object) => object.Key))),
            );
          case "/write/put":
            return yield* respond(write.putObject({ Key: key, Body: body }));
          case "/write/delete":
            return yield* respond(write.deleteObject({ Key: key }));
          case "/write/delete-many":
            return yield* respond(write.deleteObjects({ Delete: { Objects: [{ Key: key }] } }));
          case "/write/multipart":
            return yield* respond(
              Effect.gen(function* () {
                const upload = yield* write.createMultipartUpload({ Key: key });
                const part = yield* write.uploadPart({
                  Key: key,
                  UploadId: upload.UploadId!,
                  PartNumber: 1,
                  Body: body,
                });
                const parts = yield* write.listParts({ Key: key, UploadId: upload.UploadId! });
                yield* write.completeMultipartUpload({
                  Key: key,
                  UploadId: upload.UploadId!,
                  MultipartUpload: { Parts: [{ ETag: part.ETag, PartNumber: 1 }] },
                });
                return { listedParts: parts.Parts?.length };
              }),
            );
          case "/write/multipart-abort":
            return yield* respond(
              Effect.gen(function* () {
                const upload = yield* write.createMultipartUpload({ Key: key });
                yield* write.abortMultipartUpload({ Key: key, UploadId: upload.UploadId! });
              }),
            );
          case "/read-write/round-trip":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWrite.putObject({ Key: key, Body: body });
                return yield* readWrite.getObject({ Key: key }).pipe(Effect.flatMap(text));
              }),
            );
          case "/presign-get":
            return yield* respond(presignGet({ key }));
          case "/presign-put":
            return yield* respond(presignPut({ key }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.ObjectStorage.ReadBucketHttp,
        Stackit.ObjectStorage.WriteBucketHttp,
        Stackit.ObjectStorage.ReadWriteBucketHttp,
        Stackit.ObjectStorage.PresignGetObjectHttp,
        Stackit.ObjectStorage.PresignPutObjectHttp,
      ),
    ),
  ),
) {}
