import type * as Presign from "@distilled.cloud/aws/Presign";
import type * as S3 from "@distilled.cloud/aws/s3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import type { PresignError } from "./BucketTypes.ts";

export interface PresignPutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket" | "Body"> {
  /**
   * Number of seconds the URL remains valid (at most 7 days).
   * @default 900
   */
  expiresIn?: number;
}

/**
 * Mint presigned upload (PUT) URLs for objects in an R2 {@link Bucket}, so a
 * browser can upload directly to R2 without credentials and without routing
 * the body through a Worker.
 *
 * Takes the same input as `AWS.S3.PresignPutObject`: S3's `PutObject`
 * input without `Bucket` and `Body`. `x-amz-*` fields (`Metadata`, ...) are
 * signed into the URL, the others (`ContentType`, `ContentLength`,
 * `IfNoneMatch`, `ContentMD5`, checksums, ...) come back in `headers`, which
 * the uploader must send as they are or R2 rejects the upload. R2
 * implements a subset of S3's fields. See [R2's S3 API
 * compatibility](https://developers.cloudflare.com/r2/api/s3/api/).
 *
 * Presigning is a pure SigV4 computation against R2's S3-compatible API — no
 * request is made. When deployed, the binding mints a scoped account API
 * token (`Workers R2 Storage Write`) and derives R2 S3 credentials from it;
 * the URLs point at `https://{accountId}.r2.cloudflarestorage.com`.
 *
 * Under `alchemy dev`, a locally-emulated bucket is served on the Worker's
 * local S3 endpoint (`{worker url}/cdn-cgi/local/r2/s3`) and the minted URLs
 * point there — the same code runs unchanged in both modes, and objects
 * uploaded locally are visible to every local binding of the bucket.
 *
 * Browser uploads to a deployed bucket also need a matching CORS rule on the
 * {@link Bucket} (`cors` prop), allowing every header in `headers`. The
 * local endpoint always allows cross-origin requests.
 *
 * ### Presigning Upload URLs
 * **Example:** Mint a presigned PUT URL
 * ```typescript
 * const presignPut = yield* Cloudflare.R2.PresignPutObject(bucket);
 * const { url } = yield* presignPut({ Key: "uploads/avatar.png" });
 * // the browser uploads with: fetch(url, { method: "PUT", body: file })
 * ```
 *
 * **Example:** Pin the type and size, and refuse to overwrite
 * ```typescript
 * const upload = yield* presignPut({
 *   Key: "uploads/avatar.png",
 *   ContentType: "image/png",
 *   ContentLength: size, // the size the client declared, checked against your limit
 *   IfNoneMatch: "*", // fails if the key already exists
 *   expiresIn: 300, // valid for 5 minutes
 * });
 * // the browser sends: fetch(upload.url, { method: "PUT", headers: upload.headers, body })
 * ```
 *
 * **Example:** Allow browser uploads from a web app
 * ```typescript
 * const Uploads = Cloudflare.R2.Bucket("Uploads", {
 *   cors: [
 *     {
 *       allowedMethods: ["PUT"],
 *       allowedOrigins: ["https://app.example.com"],
 *       allowedHeaders: ["content-type", "if-none-match"],
 *     },
 *   ],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const presignPut = yield* Cloudflare.R2.PresignPutObject(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const upload = yield* presignPut({
 *           Key: crypto.randomUUID(),
 *           ContentType: "image/png",
 *           IfNoneMatch: "*",
 *         });
 *         return yield* HttpServerResponse.json(upload);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.R2.PresignPutObjectToken)),
 * ) {}
 * ```
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface PresignPutObject extends Binding.Service<
  PresignPutObject,
  "Cloudflare.R2.PresignPutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PresignPutObjectRequest,
    ) => Effect.Effect<Presign.PresignedRequest, PresignError, RuntimeContext>
  >
> {}

export const PresignPutObject = Binding.Service<PresignPutObject>("Cloudflare.R2.PresignPutObject");
