import type * as S3 from "@distilled.cloud/s3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import type { SpacesBindingNotConfigured } from "./BucketBinding.ts";

export interface PutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket"> {}

/**
 * Writes an object. Binding it grants the host a Spaces key with `readwrite` access to the
 * one bucket.
 *
 * **Example:** Writes an object from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const putObject = yield* DigitalOcean.Spaces.PutObject(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* putObject({ Key: "hello.txt", Body: "hello", ContentType: "text/plain" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Spaces.PutObjectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Spaces
 */
export interface PutObject extends Binding.Service<
  PutObject,
  "DigitalOcean.Spaces.PutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectRequest,
    ) => Effect.Effect<
      S3.PutObjectOutput,
      S3.PutObjectError | SpacesBindingNotConfigured,
      RuntimeContext
    >
  >
> {}

export const PutObject = Binding.Service<PutObject>("DigitalOcean.Spaces.PutObject");
