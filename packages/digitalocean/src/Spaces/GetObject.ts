import type * as S3 from "@distilled.cloud/s3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import type { SpacesBindingNotConfigured } from "./BucketBinding.ts";

export interface GetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {}

/**
 * Reads an object. Binding it grants the host a Spaces key with `read` access to the
 * one bucket.
 *
 * **Example:** Reads an object from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getObject = yield* DigitalOcean.Spaces.GetObject(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const object = yield* getObject({ Key: "hello.txt" });
 *     const text = yield* Stream.mkString(Stream.decodeText(object.Body!));
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Spaces.GetObjectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Spaces
 */
export interface GetObject extends Binding.Service<
  GetObject,
  "DigitalOcean.Spaces.GetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectRequest,
    ) => Effect.Effect<
      S3.GetObjectOutput,
      S3.GetObjectError | SpacesBindingNotConfigured,
      RuntimeContext
    >
  >
> {}

export const GetObject = Binding.Service<GetObject>("DigitalOcean.Spaces.GetObject");
