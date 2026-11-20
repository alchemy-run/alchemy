import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Bucket } from "./Bucket.ts";
import { GrantOnBucket } from "./ObjectHttp.ts";
import {
  type ObjectContent,
  type ObjectNotFound,
  type ObjectRequestFailed,
  makeObjectMedia,
} from "./ObjectMedia.ts";

export type { ObjectContent } from "./ObjectMedia.ts";

export interface GetObjectRequest {
  /** Object name (key). */
  object: string;
  /** Serve this generation instead of the live one. */
  generation?: string;
}

/**
 * Runtime binding that downloads an object's content from a Cloud Storage
 * {@link Bucket} (`objects.get` with `alt=media`). Grants
 * `roles/storage.objectViewer` on the bucket.
 *
 * Bind this operation to a {@link Bucket} in a Function/Action init phase.
 * Provide {@link GetObjectHttp}.
 *
 * ### Reading Objects
 * **Example:** Read an object as text
 * ```typescript
 * const getObject = yield* GCP.Storage.GetObject(bucket);
 * const { body } = yield* getObject({ object: "hello.txt" });
 * const text = new TextDecoder().decode(body);
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetObject extends Binding.Service<
  GetObject,
  "GCP.Storage.GetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectRequest,
    ) => Effect.Effect<ObjectContent, ObjectNotFound | ObjectRequestFailed, RuntimeContext>
  >
> {}

export const GetObject = Binding.Service<GetObject>("GCP.Storage.GetObject");

/**
 * HTTP implementation of {@link GetObject}.
 *
 * @layer
 * @provides GCP.Storage.GetObject
 */
export const GetObjectHttp = Layer.effect(
  GetObject,
  Effect.gen(function* () {
    const grantOnBucket = yield* GrantOnBucket;
    const media = yield* makeObjectMedia;
    return Effect.fn(function* (bucket: Bucket) {
      yield* grantOnBucket("GCP.Storage.GetObject", bucket, "roles/storage.objectViewer");
      const bucketName = yield* bucket.bucketName;
      return Effect.fn(`GCP.Storage.GetObject(${bucket.LogicalId})`)(function* (
        request: GetObjectRequest,
      ) {
        return yield* media.download({
          bucket: yield* bucketName,
          object: request.object,
          generation: request.generation,
        });
      });
    });
  }),
);
