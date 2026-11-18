import type * as S3 from "@distilled.cloud/s3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import type { SpacesBindingNotConfigured } from "./BucketBinding.ts";

export interface ListObjectsV2Request extends Omit<S3.ListObjectsV2Request, "Bucket"> {}

/**
 * Lists the objects under a prefix. Binding it grants the host a Spaces key with `read` access to the
 * one bucket.
 *
 * **Example:** Lists the objects under a prefix from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listObjects = yield* DigitalOcean.Spaces.ListObjectsV2(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* listObjects({ Prefix: "uploads/" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Spaces.ListObjectsV2Http)),
 * ) {}
 * ```
 *
 * @binding
 * @product Spaces
 */
export interface ListObjectsV2 extends Binding.Service<
  ListObjectsV2,
  "DigitalOcean.Spaces.ListObjectsV2",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: ListObjectsV2Request,
    ) => Effect.Effect<
      S3.ListObjectsV2Output,
      S3.ListObjectsV2Error | SpacesBindingNotConfigured,
      RuntimeContext
    >
  >
> {}

export const ListObjectsV2 = Binding.Service<ListObjectsV2>("DigitalOcean.Spaces.ListObjectsV2");
