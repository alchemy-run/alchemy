import type * as storage from "@distilled.cloud/gcp/storage_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectRequest extends Omit<
  storage.InsertObjectsRequest,
  "bucket"
> {}

/**
 * Runtime binding for Cloud Storage `objects.insert`.
 *
 * Bind this operation to a {@link Bucket} in a Function/Action init phase.
 * Provide {@link PutObjectHttp}.
 *
 * ### Writing Objects
 * **Example:** Insert object metadata
 * ```typescript
 * const putObject = yield* GCP.Storage.PutObject(bucket);
 * yield* putObject({
 *   name: "hello.txt",
 *   body: { name: "hello.txt", contentType: "text/plain" },
 * });
 * ```
 *
 * @binding
 * @product GCP
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
    ) => Effect.Effect<
      storage.Storage_Object,
      storage.InsertObjectsError,
      RuntimeContext
    >
  >
> {}

export const PutObject = Binding.Service<PutObject>("GCP.Storage.PutObject");
