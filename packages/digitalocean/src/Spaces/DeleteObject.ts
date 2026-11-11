import type * as S3 from "@distilled.cloud/s3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import type { SpacesBindingNotConfigured } from "./BucketBinding.ts";

export interface DeleteObjectRequest extends Omit<S3.DeleteObjectRequest, "Bucket"> {}

/**
 * Deletes an object. Binding it grants the host a Spaces key with `readwrite` access to the
 * one bucket.
 *
 * **Example:** Deletes an object from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const deleteObject = yield* DigitalOcean.Spaces.DeleteObject(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteObject({ Key: "hello.txt" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Spaces.DeleteObjectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Spaces
 */
export interface DeleteObject extends Binding.Service<
  DeleteObject,
  "DigitalOcean.Spaces.DeleteObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: DeleteObjectRequest,
    ) => Effect.Effect<
      S3.DeleteObjectOutput,
      S3.DeleteObjectError | SpacesBindingNotConfigured,
      RuntimeContext
    >
  >
> {}

export const DeleteObject = Binding.Service<DeleteObject>("DigitalOcean.Spaces.DeleteObject");
