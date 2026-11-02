import type * as s3 from "@distilled.cloud/aws/s3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";

/** The write operations on a bound bucket. The bucket name is injected. */
export interface WriteBucketClient {
  /** Write an object. */
  putObject(
    request: Omit<s3.PutObjectRequest, "Bucket">,
  ): Effect.Effect<s3.PutObjectOutput, s3.PutObjectError, RuntimeContext>;
  /** Delete an object. */
  deleteObject(
    request: Omit<s3.DeleteObjectRequest, "Bucket">,
  ): Effect.Effect<s3.DeleteObjectOutput, s3.DeleteObjectError, RuntimeContext>;
  /** Delete several objects in one request. */
  deleteObjects(
    request: Omit<s3.DeleteObjectsRequest, "Bucket">,
  ): Effect.Effect<s3.DeleteObjectsOutput, s3.DeleteObjectsError, RuntimeContext>;
  /** Start a multipart upload. */
  createMultipartUpload(
    request: Omit<s3.CreateMultipartUploadRequest, "Bucket">,
  ): Effect.Effect<s3.CreateMultipartUploadOutput, s3.CreateMultipartUploadError, RuntimeContext>;
  /** Upload one part of a multipart upload. */
  uploadPart(
    request: Omit<s3.UploadPartRequest, "Bucket">,
  ): Effect.Effect<s3.UploadPartOutput, s3.UploadPartError, RuntimeContext>;
  /** List the parts of a multipart upload that have arrived. */
  listParts(
    request: Omit<s3.ListPartsRequest, "Bucket">,
  ): Effect.Effect<s3.ListPartsOutput, s3.ListPartsError, RuntimeContext>;
  /** Finish a multipart upload. */
  completeMultipartUpload(
    request: Omit<s3.CompleteMultipartUploadRequest, "Bucket">,
  ): Effect.Effect<
    s3.CompleteMultipartUploadOutput,
    s3.CompleteMultipartUploadError,
    RuntimeContext
  >;
  /** Abandon a multipart upload and delete its parts. */
  abortMultipartUpload(
    request: Omit<s3.AbortMultipartUploadRequest, "Bucket">,
  ): Effect.Effect<s3.AbortMultipartUploadOutput, s3.AbortMultipartUploadError, RuntimeContext>;
}

/**
 * Write and delete a {@link Bucket}'s objects from a Function/Worker over the S3
 * API.
 *
 * Bind it in the init phase and provide {@link WriteBucketHttp}. It works on any
 * host.
 *
 * Access: Alchemy creates a `CredentialsGroup` and an `AccessKey` for each host
 * and bucket, binds the key into the host's env, and adds statements to the
 * bucket's policy limiting the group to `s3:PutObject`, `s3:PutOverwriteObject`,
 * `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:AbortMultipartUpload` and
 * `s3:ListMultipartUploadParts` there. A bucket policy speaks only for its own
 * bucket, and STACKIT's examples show a credentials group reaching a bucket
 * unless that bucket's policy denies it, so the key can still use other buckets
 * in the project. Give a bucket its own `policy` to deny such groups. The
 * deployer needs Object Storage permissions to create the group and key.
 *
 * ### Writing Objects
 * **Example:** Write an object from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Uploads = Stackit.ObjectStorage.Bucket("Uploads", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const uploads = yield* Stackit.ObjectStorage.WriteBucket(yield* Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* uploads.putObject({
 *           Key: "hello.txt",
 *           Body: "Hello, World!",
 *           ContentType: "text/plain",
 *         });
 *         return HttpServerResponse.text("stored");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ObjectStorage.WriteBucketHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ObjectStorage
 */
export interface WriteBucket extends Binding.Service<
  WriteBucket,
  "Stackit.ObjectStorage.WriteBucket",
  (bucket: Bucket) => Effect.Effect<WriteBucketClient>
> {}

export const WriteBucket = Binding.Service<WriteBucket>("Stackit.ObjectStorage.WriteBucket");
