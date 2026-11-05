import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Credentials } from "../Credentials.ts";
import { authorizeWith } from "../HttpClientUtils.ts";
import type { Bucket } from "./Bucket.ts";
import {
  baseObject,
  makeHttpBucketBinding,
  makeR2HttpScope,
  readHttpMetadata,
  toBody,
  toR2Error,
  type R2Auth,
} from "./BucketHttp.ts";
import { R2Error, type PutOptions } from "./BucketTypes.ts";
import { inJurisdiction } from "./internal/Jurisdiction.ts";
import { WriteBucket, type WriteBucketClient } from "./WriteBucket.ts";

/**
 * HTTP-backed implementation of the {@link WriteBucket} binding.
 *
 * It creates a scoped {@link AccountApiToken} with the `Workers R2 Storage Read` and `Workers R2 Storage Write` permissions.
 */
export const WriteBucketHttp = Layer.effect(
  WriteBucket,
  Effect.suspend(() =>
    makeHttpBucketBinding({
      permissionGroups: ["Workers R2 Storage Write"],
      makeClient: (token, bucketName, jurisdiction) =>
        makeWriteR2HttpClient(
          { authorize: authorizeWith(token), accountId: token.accountId },
          bucketName,
          jurisdiction,
        ),
    }),
  ),
);

/** Build the write half of the HTTP-backed {@link ReadWrite} client. */
export const makeWriteR2HttpClient = (
  auth: R2Auth,
  bucketName: Effect.Effect<string>,
  jurisdiction: Effect.Effect<string>,
): WriteBucketClient => {
  // Each call goes to the bucket's jurisdiction.
  const authorize = <A, E>(
    jurisdiction: Bucket.Jurisdiction | undefined,
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => auth.authorize(inJurisdiction(jurisdiction)(eff));
  const scope = makeR2HttpScope(auth.accountId, bucketName, jurisdiction);

  return {
    put: ((
      key: string,
      value:
        | ReadableStream
        | ArrayBuffer
        | ArrayBufferView
        | string
        | null
        | Blob
        | Stream.Stream<Uint8Array, unknown>,
      options?: PutOptions,
    ) =>
      scope.pipe(
        Effect.flatMap(({ accountId, bucketName, jurisdiction }) =>
          toBody(value).pipe(
            Effect.flatMap(({ body, contentLength }) => {
              const meta = readHttpMetadata(options);
              return authorize(
                jurisdiction,
                r2.putObject({
                  accountId,
                  bucketName,
                  objectName: key,
                  body,
                  contentType: meta?.contentType,
                  contentEncoding: meta?.contentEncoding,
                  contentDisposition: meta?.contentDisposition,
                  contentLanguage: meta?.contentLanguage,
                  cacheControl: meta?.cacheControl,
                  contentLength:
                    options?.contentLength != null
                      ? String(options.contentLength)
                      : contentLength != null
                        ? String(contentLength)
                        : undefined,
                  cfR2StorageClass: (options as { storageClass?: string } | undefined)
                    ?.storageClass,
                }),
              ).pipe(
                Effect.map(() =>
                  baseObject(key, meta ?? {}, {
                    size: contentLength,
                    customMetadata: (
                      options as { customMetadata?: Record<string, string> } | undefined
                    )?.customMetadata,
                    storageClass: (options as { storageClass?: string } | undefined)?.storageClass,
                    uploaded: new Date(),
                  }),
                ),
              );
            }),
          ),
        ),
        Effect.mapError(toR2Error),
      )) as any,
    delete: (keys: string | string[]) =>
      scope.pipe(
        Effect.flatMap(({ accountId, bucketName, jurisdiction }) =>
          Array.isArray(keys)
            ? authorize(
                jurisdiction,
                r2.deleteObjects({
                  accountId,
                  bucketName,
                  body: keys,
                }),
              ).pipe(Effect.asVoid, Effect.mapError(toR2Error))
            : authorize(
                jurisdiction,
                r2.deleteObject({
                  accountId,
                  bucketName,
                  objectName: keys,
                }),
              ).pipe(
                Effect.asVoid,
                // The native binding's `delete` is idempotent — deleting a
                // key that isn't there resolves. Keep the HTTP client at
                // parity instead of surfacing R2's `NoSuchKey`.
                Effect.catchTag("NoSuchKey", () => Effect.void),
                Effect.mapError(toR2Error),
              ),
        ),
      ),
    createMultipartUpload: () =>
      Effect.die(
        new R2Error({
          message: "R2BucketBindingHttp does not support multipart uploads over the HTTP API.",
          cause: new Error("unsupported"),
        }),
      ),
    resumeMultipartUpload: () =>
      Effect.die(
        new R2Error({
          message: "R2BucketBindingHttp does not support multipart uploads over the HTTP API.",
          cause: new Error("unsupported"),
        }),
      ),
  };
};
