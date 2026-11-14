import type * as S3 from "@distilled.cloud/s3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import type { SpacesBindingNotConfigured } from "./BucketBinding.ts";

export interface HeadObjectRequest extends Omit<S3.HeadObjectRequest, "Bucket"> {}

/**
 * Reads an object's metadata without its body. Binding it grants the host a Spaces key with `read` access to the
 * one bucket.
 *
 * **Example:** Reads an object's metadata without its body from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const headObject = yield* DigitalOcean.Spaces.HeadObject(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const head = yield* headObject({ Key: "hello.txt" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Spaces.HeadObjectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Spaces
 */
export interface HeadObject extends Binding.Service<
  HeadObject,
  "DigitalOcean.Spaces.HeadObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: HeadObjectRequest,
    ) => Effect.Effect<
      S3.HeadObjectOutput,
      S3.HeadObjectError | SpacesBindingNotConfigured,
      RuntimeContext
    >
  >
> {}

export const HeadObject = Binding.Service<HeadObject>("DigitalOcean.Spaces.HeadObject");
