import type * as Presign from "@distilled.cloud/aws/Presign";
import type * as S3 from "@distilled.cloud/aws/s3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import type { PresignError } from "./BucketTypes.ts";

export interface PresignGetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {
  /**
   * Number of seconds the URL remains valid (at most 7 days).
   * @default 900
   */
  expiresIn?: number;
}

/**
 * Mint presigned download (GET) URLs for objects in an R2 {@link Bucket}, so
 * a browser or any HTTP client can read an object without credentials or a
 * Worker in the request path.
 *
 * Takes the same input as `AWS.S3.PresignGetObject`: S3's `GetObject`
 * input without `Bucket`. Query fields (the `ResponseContent*` overrides,
 * `PartNumber`) are signed into the URL. Header fields (`Range`, `IfMatch`,
 * ...) come back in `headers`, which the downloader must send as they are.
 * R2 implements a subset of S3's fields. See [R2's S3 API
 * compatibility](https://developers.cloudflare.com/r2/api/s3/api/).
 *
 * Presigning is a pure SigV4 computation against R2's S3-compatible API — no
 * request is made. When deployed, the binding mints a scoped account API
 * token (`Workers R2 Storage Read`) and derives R2 S3 credentials from it;
 * the URLs point at `https://{accountId}.r2.cloudflarestorage.com`.
 *
 * Under `alchemy dev`, a locally-emulated bucket is served on the Worker's
 * local S3 endpoint (`{worker url}/cdn-cgi/local/r2/s3`) and the minted URLs
 * point there — the same code runs unchanged in both modes.
 *
 * ### Presigning Download URLs
 * **Example:** Mint a presigned GET URL
 * ```typescript
 * const presignGet = yield* Cloudflare.R2.PresignGetObject(bucket);
 * const { url } = yield* presignGet({ Key: "reports/2026-09.pdf" });
 * // hand `url` to a browser — it can GET the object without credentials
 * ```
 *
 * **Example:** Force a download with a short-lived URL
 * ```typescript
 * const { url } = yield* presignGet({
 *   Key: "reports/2026-09.pdf",
 *   ResponseContentDisposition: 'attachment; filename="report.pdf"',
 *   expiresIn: 60,
 * });
 * ```
 *
 * **Example:** Provide the implementation on a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const presignGet = yield* Cloudflare.R2.PresignGetObject(Files);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { url } = yield* presignGet({ Key: "hello.txt" });
 *         return HttpServerResponse.redirect(url);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.R2.PresignGetObjectToken)),
 * ) {}
 * ```
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface PresignGetObject extends Binding.Service<
  PresignGetObject,
  "Cloudflare.R2.PresignGetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PresignGetObjectRequest,
    ) => Effect.Effect<Presign.PresignedRequest, PresignError, RuntimeContext>
  >
> {}

export const PresignGetObject = Binding.Service<PresignGetObject>("Cloudflare.R2.PresignGetObject");
