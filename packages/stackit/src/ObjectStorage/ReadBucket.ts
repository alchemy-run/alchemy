import type * as s3 from "@distilled.cloud/aws/s3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";

/** The read operations on a bound bucket. The bucket name is injected. */
export interface ReadBucketClient {
  /** Read an object. A missing key fails with `NoSuchKey`. */
  getObject(
    request: Omit<s3.GetObjectRequest, "Bucket">,
  ): Effect.Effect<s3.GetObjectOutput, s3.GetObjectError, RuntimeContext>;
  /** Read an object's metadata. A missing key fails with `NotFound`. */
  headObject(
    request: Omit<s3.HeadObjectRequest, "Bucket">,
  ): Effect.Effect<s3.HeadObjectOutput, s3.HeadObjectError, RuntimeContext>;
  /** List one page of the bucket's objects. */
  listObjects(
    request?: Omit<s3.ListObjectsV2Request, "Bucket">,
  ): Effect.Effect<s3.ListObjectsV2Output, s3.ListObjectsV2Error, RuntimeContext>;
}

/**
 * Read a {@link Bucket}'s objects from a Function/Worker over the S3 API.
 *
 * Bind it in the init phase and provide {@link ReadBucketHttp}. It works on any
 * host.
 *
 * Access: Alchemy creates a `CredentialsGroup` and an `AccessKey` for each host
 * and bucket, binds the key into the host's env, and adds statements to the
 * bucket's policy limiting the group to `s3:GetObject`, `s3:GetObjectVersion` and
 * `s3:ListBucket` there. A bucket policy speaks only for its own bucket, and
 * STACKIT's examples show a credentials group reaching a bucket unless that
 * bucket's policy denies it, so the key can still use other buckets in the
 * project. Give a bucket its own `policy` to deny such groups. The deployer needs
 * Object Storage permissions to create the group and key.
 *
 * ### Reading Objects
 * **Example:** Read an object from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Stream from "effect/Stream";
 *
 * export const Assets = Stackit.ObjectStorage.Bucket("Assets", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const assets = yield* Stackit.ObjectStorage.ReadBucket(yield* Assets);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const object = yield* assets.getObject({ Key: "hello.txt" });
 *         const text = yield* Stream.mkString(Stream.decodeText(object.Body!));
 *         return HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ObjectStorage.ReadBucketHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ObjectStorage
 */
export interface ReadBucket extends Binding.Service<
  ReadBucket,
  "Stackit.ObjectStorage.ReadBucket",
  (bucket: Bucket) => Effect.Effect<ReadBucketClient>
> {}

export const ReadBucket = Binding.Service<ReadBucket>("Stackit.ObjectStorage.ReadBucket");
