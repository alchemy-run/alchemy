import type { PresignError } from "@distilled.cloud/aws/Presign";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";

export interface PresignGetObjectRequest {
  /** Key of the object to mint a download URL for. */
  key: string;
  /** Specific object version to download. Defaults to the current version. */
  versionId?: string;
  /**
   * Number of seconds the URL stays valid.
   * @default 900
   */
  expiresIn?: number;
  /** Override the `Content-Type` of the response. */
  contentType?: string;
}

/**
 * Mint presigned download URLs for objects in a {@link Bucket}.
 *
 * Presigning computes a signature locally and makes no API call. Bind it in the
 * init phase and provide {@link PresignGetObjectHttp}. It works on any host.
 *
 * Access: the URL carries the access of the key that signed it, so this binding
 * holds the same key and policy statements as {@link ReadBucket}, and shares them
 * with it on one host. See `ReadBucket` for what that key can reach.
 *
 * ### Presigning Download URLs
 * **Example:** Hand a browser a download URL from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Reports = Stackit.ObjectStorage.Bucket("Reports", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const presign = yield* Stackit.ObjectStorage.PresignGetObject(yield* Reports);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const url = yield* presign({ key: "2026.pdf", expiresIn: 300 });
 *         return yield* HttpServerResponse.json({ url });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ObjectStorage.PresignGetObjectHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category ObjectStorage
 */
export interface PresignGetObject extends Binding.Service<
  PresignGetObject,
  "Stackit.ObjectStorage.PresignGetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (request: PresignGetObjectRequest) => Effect.Effect<string, PresignError, RuntimeContext>
  >
> {}

export const PresignGetObject = Binding.Service<PresignGetObject>(
  "Stackit.ObjectStorage.PresignGetObject",
);
