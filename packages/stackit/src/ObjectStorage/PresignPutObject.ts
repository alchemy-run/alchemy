import type { PresignError } from "@distilled.cloud/aws/Presign";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";

export interface PresignPutObjectRequest {
  /** Key of the object to mint an upload URL for. */
  key: string;
  /**
   * Number of seconds the URL stays valid.
   * @default 900
   */
  expiresIn?: number;
  /**
   * `Content-Type` to sign into the URL. The uploader must send exactly this
   * header, or the upload fails with a signature mismatch.
   */
  contentType?: string;
}

/**
 * Mint presigned upload URLs for objects in a {@link Bucket}.
 *
 * Presigning computes a signature locally and makes no API call. Bind it in the
 * init phase and provide {@link PresignPutObjectHttp}. It works on any host.
 *
 * Access: the URL carries the access of the key that signed it, so this binding
 * holds the same key and policy statements as {@link WriteBucket}, and shares
 * them with it on one host. See `WriteBucket` for what that key can reach.
 *
 * ### Presigning Upload URLs
 * **Example:** Hand a browser an upload URL from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Uploads = Stackit.ObjectStorage.Bucket("Uploads", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const presign = yield* Stackit.ObjectStorage.PresignPutObject(yield* Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const url = yield* presign({ key: "avatar.png", contentType: "image/png" });
 *         return yield* HttpServerResponse.json({ url });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ObjectStorage.PresignPutObjectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ObjectStorage
 */
export interface PresignPutObject extends Binding.Service<
  PresignPutObject,
  "Stackit.ObjectStorage.PresignPutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (request: PresignPutObjectRequest) => Effect.Effect<string, PresignError, RuntimeContext>
  >
> {}

export const PresignPutObject = Binding.Service<PresignPutObject>(
  "Stackit.ObjectStorage.PresignPutObject",
);
