import type * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Bucket } from "./Bucket.ts";
import { GrantOnBucket } from "./ObjectHttp.ts";
import {
  type ObjectNotFound,
  type ObjectRequestFailed,
  type PutObjectContent,
  makeObjectMedia,
} from "./ObjectMedia.ts";

export type PutObjectRequest = PutObjectContent;

/**
 * Runtime binding that uploads an object's content to a Cloud Storage
 * {@link Bucket} (multipart `objects.insert`), overwriting any live object
 * with the same name. Grants `roles/storage.objectUser` on the bucket
 * (overwrite needs delete permission, which `objectCreator` lacks).
 *
 * Bind this operation to a {@link Bucket} in a Function/Action init phase.
 * Provide {@link PutObjectHttp}.
 *
 * ### Writing Objects
 * **Example:** Write a text object
 * ```typescript
 * const putObject = yield* GCP.Storage.PutObject(bucket);
 * yield* putObject({ name: "hello.txt", body: "Hello, World!" });
 * ```
 *
 * **Example:** Write bytes with metadata
 * ```typescript
 * yield* putObject({
 *   name: "report.json",
 *   body: new TextEncoder().encode(JSON.stringify(report)),
 *   contentType: "application/json",
 *   metadata: { source: "nightly" },
 * });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface PutObject extends Binding.Service<
  PutObject,
  "GCP.Storage.PutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectRequest,
    ) => Effect.Effect<storage.Storage_Object, ObjectNotFound | ObjectRequestFailed, RuntimeContext>
  >
> {}

export const PutObject = Binding.Service<PutObject>("GCP.Storage.PutObject");

/**
 * HTTP implementation of {@link PutObject}.
 *
 * @layer
 * @provides GCP.Storage.PutObject
 */
export const PutObjectHttp = Layer.effect(
  PutObject,
  Effect.gen(function* () {
    const grantOnBucket = yield* GrantOnBucket;
    const media = yield* makeObjectMedia;
    return Effect.fn(function* (bucket: Bucket) {
      yield* grantOnBucket("GCP.Storage.PutObject", bucket, "roles/storage.objectUser");
      const bucketName = yield* bucket.bucketName;
      return Effect.fn(`GCP.Storage.PutObject(${bucket.LogicalId})`)(function* (
        request: PutObjectRequest,
      ) {
        const name = yield* bucketName;
        return yield* media.upload(name, request);
      });
    });
  }),
);
