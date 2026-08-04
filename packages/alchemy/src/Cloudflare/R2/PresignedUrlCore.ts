/**
 * Pure SigV4 query-string presigning for R2 — the shared core that
 * every {@link PresignedUrlClient} implementation calls. The
 * Worker-binding, HTTP, and local variants all end up here.
 *
 * Uses `aws4fetch.AwsV4Signer` for the actual HMAC computation since
 * it works in workerd (Web Crypto under the hood) and Node.
 */

import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AwsV4Signer } from "aws4fetch";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  R2_SIGNING_REGION,
  r2ObjectUrl,
  type R2PresignCredentials,
} from "./R2PresignAuth.ts";
import {
  PresignedUrl,
  type PresignGetOptions,
  type PresignHeadOptions,
  type PresignDeleteOptions,
  type PresignPutOptions,
  type PresignedUrlClient,
  type PresignedUrlMethod,
  type PresignedUrlResult,
} from "./PresignedUrl.ts";
import type { Bucket } from "./Bucket.ts";

const MAX_EXPIRES_IN = 604800;
const DEFAULT_EXPIRES_IN = 3600;

const resolveExpiresIn = (value: number | undefined): number => {
  const v = value ?? DEFAULT_EXPIRES_IN;
  if (v <= 0) return DEFAULT_EXPIRES_IN;
  if (v > MAX_EXPIRES_IN) return MAX_EXPIRES_IN;
  return v;
};

const putSignedHeaders = (options: PresignPutOptions | undefined): string => {
  const headers: string[] = ["host"];
  if (options?.contentType !== undefined) headers.push("content-type");
  if (options?.contentDisposition !== undefined)
    headers.push("content-disposition");
  if (options?.contentEncoding !== undefined) headers.push("content-encoding");
  if (options?.cacheControl !== undefined) headers.push("cache-control");
  if (options?.contentLength !== undefined) headers.push("content-length");
  headers.sort();
  return headers.join(";");
};

const putHeaderValues = (
  options: PresignPutOptions | undefined,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (options?.contentType !== undefined)
    headers["content-type"] = options.contentType;
  if (options?.contentDisposition !== undefined)
    headers["content-disposition"] = options.contentDisposition;
  if (options?.contentEncoding !== undefined)
    headers["content-encoding"] = options.contentEncoding;
  if (options?.cacheControl !== undefined)
    headers["cache-control"] = options.cacheControl;
  if (options?.contentLength !== undefined)
    headers["content-length"] = String(options.contentLength);
  return headers;
};

const getSignedHeaders = (options: PresignGetOptions | undefined): string => {
  const headers: string[] = ["host"];
  if (options?.responseContentType !== undefined) headers.push("content-type");
  if (options?.responseContentDisposition !== undefined)
    headers.push("content-disposition");
  if (options?.responseCacheControl !== undefined)
    headers.push("cache-control");
  headers.sort();
  return headers.join(";");
};

const getHeaderValues = (
  _options: PresignGetOptions | undefined,
): Record<string, string> => ({});

export interface SignedUrlInputs {
  readonly credentials: R2PresignCredentials;
  readonly method: PresignedUrlMethod;
  readonly url: string;
  readonly expiresIn: number;
  readonly signedHeaders: string;
  readonly headers: Record<string, string>;
}

export interface SignedUrlResult {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: Date;
}

/**
 * Run `aws4fetch.AwsV4Signer` with the right options for an R2 object.
 * Pure computation — no I/O. Errors only when `aws4fetch` throws
 * (very rare; mostly malformed inputs the type system already
 * rejected).
 *
 * `X-Amz-Expires` is added to the URL before signing so it ends up
 * inside the canonical query string — `aws4fetch` does not inject it
 * itself.
 */
export const signR2ObjectUrl = (
  inputs: SignedUrlInputs,
): Effect.Effect<SignedUrlResult, Error> =>
  Effect.gen(function* () {
    const { credentials, method, url, expiresIn, signedHeaders, headers } =
      inputs;

    const target = new URL(url);
    target.searchParams.set("X-Amz-Expires", String(expiresIn));

    const signer = new AwsV4Signer({
      method,
      url: target.toString(),
      headers,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: Redacted.value(credentials.secretAccessKey),
      service: "s3",
      region: R2_SIGNING_REGION,
      signQuery: true,
      allHeaders: signedHeaders !== "host",
      appendSessionToken: false,
      singleEncode: true,
    });

    const signed = yield* Effect.tryPromise(() => signer.sign());

    const signedAt = Date.now();
    return {
      url: signed.url.toString(),
      headers,
      expiresAt: new Date(signedAt + expiresIn * 1000),
    } satisfies SignedUrlResult;
  });

export const makePresignedUrlClient = (
  credentials: R2PresignCredentials,
  bucketName: string,
): PresignedUrlClient => ({
  presignGet: (key, options) =>
    Effect.gen(function* () {
      const expiresIn = resolveExpiresIn(options?.expiresIn);
      const url = r2ObjectUrl(credentials.accountId, bucketName, key);
      const signedHeaders = getSignedHeaders(options);
      const signed = yield* signR2ObjectUrl({
        credentials,
        method: "GET",
        url,
        expiresIn,
        signedHeaders,
        headers: getHeaderValues(options),
      });
      return signed as PresignedUrlResult;
    }) as unknown as Effect.Effect<PresignedUrlResult, never, RuntimeContext>,

  presignPut: (key, options) =>
    Effect.gen(function* () {
      const expiresIn = resolveExpiresIn(options?.expiresIn);
      const url = r2ObjectUrl(credentials.accountId, bucketName, key);
      const signedHeaders = putSignedHeaders(options);
      const signed = yield* signR2ObjectUrl({
        credentials,
        method: "PUT",
        url,
        expiresIn,
        signedHeaders,
        headers: putHeaderValues(options),
      });
      return signed as PresignedUrlResult;
    }) as unknown as Effect.Effect<PresignedUrlResult, never, RuntimeContext>,

  presignDelete: (key, options) =>
    Effect.gen(function* () {
      const expiresIn = resolveExpiresIn(options?.expiresIn);
      const url = r2ObjectUrl(credentials.accountId, bucketName, key);
      const signed = yield* signR2ObjectUrl({
        credentials,
        method: "DELETE",
        url,
        expiresIn,
        signedHeaders: "host",
        headers: {},
      });
      return signed as PresignedUrlResult;
    }) as unknown as Effect.Effect<PresignedUrlResult, never, RuntimeContext>,

  presignHead: (key, options) =>
    Effect.gen(function* () {
      const expiresIn = resolveExpiresIn(options?.expiresIn);
      const url = r2ObjectUrl(credentials.accountId, bucketName, key);
      const signed = yield* signR2ObjectUrl({
        credentials,
        method: "HEAD",
        url,
        expiresIn,
        signedHeaders: "host",
        headers: {},
      });
      return signed as PresignedUrlResult;
    }) as unknown as Effect.Effect<PresignedUrlResult, never, RuntimeContext>,
});

export { PresignedUrl };
export type {
  PresignGetOptions,
  PresignHeadOptions,
  PresignDeleteOptions,
  PresignPutOptions,
  PresignedUrlClient,
  PresignedUrlResult,
  PresignedUrlMethod,
};
