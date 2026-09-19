import type * as storage from "@distilled.cloud/gcp/storage_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectRequest extends Omit<
  storage.GetObjectsRequest,
  "bucket"
> {}

/**
 * Runtime binding for Cloud Storage `objects.get`.
 *
 * Bind this operation to a {@link Bucket} in a Function/Action init phase.
 * Provide {@link GetObjectHttp}.
 *
 * ### Reading Objects
 * **Example:** Read object metadata
 * ```typescript
 * const getObject = yield* GCP.Storage.GetObject(bucket);
 * const object = yield* getObject({ object: "hello.txt" });
 * ```
 *
 * @binding
 * @product GCP
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
    ) => Effect.Effect<
      storage.Storage_Object,
      storage.GetObjectsError,
      RuntimeContext
    >
  >
> {}

export const GetObject = Binding.Service<GetObject>("GCP.Storage.GetObject");
