import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import type { ReadBucketClient } from "./ReadBucket.ts";
import type { WriteBucketClient } from "./WriteBucket.ts";

/** Every read and write operation on a bound bucket. */
export interface ReadWriteBucketClient extends ReadBucketClient, WriteBucketClient {}

/**
 * Read, write and delete a {@link Bucket}'s objects from a Function/Worker over
 * the S3 API.
 *
 * Bind it in the init phase and provide {@link ReadWriteBucketHttp}. It works on
 * any host.
 *
 * Access: Alchemy creates a `CredentialsGroup` and an `AccessKey` for each host
 * and bucket, binds the key into the host's env, and adds statements to the
 * bucket's policy limiting the group to the actions of `ReadBucket` and
 * `WriteBucket` there. A bucket policy speaks only for its own bucket, and
 * STACKIT's examples show a credentials group reaching a bucket unless that
 * bucket's policy denies it, so the key can still use other buckets in the
 * project. Give a bucket its own `policy` to deny such groups. The deployer needs
 * Object Storage permissions to create the group and key.
 *
 * ### Reading and Writing Objects
 * **Example:** Copy an object's text from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Stream from "effect/Stream";
 *
 * export const Files = Stackit.ObjectStorage.Bucket("Files", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const files = yield* Stackit.ObjectStorage.ReadWriteBucket(yield* Files);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const object = yield* files.getObject({ Key: "in.txt" });
 *         const text = yield* Stream.mkString(Stream.decodeText(object.Body!));
 *         yield* files.putObject({ Key: "out.txt", Body: text });
 *         return HttpServerResponse.text("copied");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ObjectStorage.ReadWriteBucketHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ObjectStorage
 */
export interface ReadWriteBucket extends Binding.Service<
  ReadWriteBucket,
  "Stackit.ObjectStorage.ReadWriteBucket",
  (bucket: Bucket) => Effect.Effect<ReadWriteBucketClient>
> {}

export const ReadWriteBucket = Binding.Service<ReadWriteBucket>(
  "Stackit.ObjectStorage.ReadWriteBucket",
);
