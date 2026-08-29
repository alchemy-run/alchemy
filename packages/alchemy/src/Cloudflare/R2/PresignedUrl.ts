import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";

export type PresignedUrlMethod = "GET" | "PUT" | "POST" | "DELETE" | "HEAD";

export interface PresignBaseOptions {
  /**
   * URL validity window in seconds. R2 accepts at most 604800 (7 days);
   * values above that are clamped.
   * @default 3600 (1 hour)
   */
  expiresIn?: number;
}

export interface PresignGetOptions extends PresignBaseOptions {
  responseContentType?: string;
  responseContentDisposition?: string;
  responseCacheControl?: string;
}

export interface PresignPutOptions extends PresignBaseOptions {
  /**
   * `Content-Type` the uploader must send (signed into the URL).
   */
  contentType?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  /**
   * `Content-Length` the uploader must send (signed into the URL).
   */
  contentLength?: number;
}

export type PresignHeadOptions = PresignBaseOptions;
export type PresignDeleteOptions = PresignBaseOptions;

export interface PresignedUrlResult {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignedUrlClient {
  presignGet(
    key: string,
    options?: PresignGetOptions,
  ): Effect.Effect<PresignedUrlResult, never, RuntimeContext>;
  presignPut(
    key: string,
    options?: PresignPutOptions,
  ): Effect.Effect<PresignedUrlResult, never, RuntimeContext>;
  presignDelete(
    key: string,
    options?: PresignDeleteOptions,
  ): Effect.Effect<PresignedUrlResult, never, RuntimeContext>;
  presignHead(
    key: string,
    options?: PresignHeadOptions,
  ): Effect.Effect<PresignedUrlResult, never, RuntimeContext>;
}

/**
 * @binding
 * @product R2
 * @category Storage & Databases
 *
 * `PresignedUrl` is the R2 presign capability — bind it in the Worker's
 * init phase to get a {@link PresignedUrlClient} that hands out
 * short-lived SigV4-signed URLs for direct browser↔R2 uploads /
 * downloads.
 *
 * SigV4 query-string signing is performed entirely client-side via
 * `aws4fetch.AwsV4Signer` (Web Crypto); no API call is made and the
 * R2 access keys stay out of the SPA bundle.
 *
 * @example Upload from the browser
 * ```typescript
 * import * as Cloudflare from "alchemy/cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class MediaUploader extends Cloudflare.Worker<MediaUploader>()(
 *   "MediaUploader",
 *   {
 *     main: import.meta.url,
 *     bindings: { MEDIA: Media },
 *   },
 *   Effect.gen(function* () {
 *     const presign = yield* Cloudflare.R2.PresignedUrl(Media);
 *
 *     return {
 *       fetch: Effect.fn(function* () {
 *         const request = yield* HttpServerRequest;
 *         const { key, contentType } = (yield* request.json) as {
 *           key: string;
 *           contentType: string;
 *         };
 *         const { url } = yield* presign.presignPut(key, {
 *           contentType,
 *           expiresIn: 300,
 *         });
 *         return yield* HttpServerResponse.json({ url });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.R2.PresignedUrlBinding)),
 * ) {}
 * ```
 */
export interface PresignedUrlService extends Binding.Service<
  PresignedUrlService,
  "Cloudflare.R2.PresignedUrl",
  (bucket: import("./Bucket.ts").Bucket) => Effect.Effect<PresignedUrlClient>
> {}

export const PresignedUrl = Binding.Service<PresignedUrlService>(
  "Cloudflare.R2.PresignedUrl",
);
