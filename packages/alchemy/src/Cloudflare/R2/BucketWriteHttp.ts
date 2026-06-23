import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { authorizeWith } from "../HttpClientUtils.ts";
import {
  baseObject,
  makeHttpBucketBinding,
  makeR2HttpScope,
  readHttpMetadata,
  toBody,
  toR2Error,
  type R2HttpToken,
} from "./BucketHttp.ts";
import { R2Error, type R2PutOptions } from "./BucketTypes.ts";
import { BucketWrite, type WriteBucketClient } from "./BucketWrite.ts";

/**
 * HTTP-backed implementation of the {@link BucketWrite} service.
 *
 * It creates a scoped {@link AccountApiToken} with the `Workers R2 Storage Read` and `Workers R2 Storage Write` permissions.
 */
export const WriteBucketHttp = Layer.effect(
  BucketWrite,
  Effect.suspend(() =>
    makeHttpBucketBinding({
      permissionGroups: ["Workers R2 Storage Write"],
      makeClient: makeWriteR2HttpClient,
    }),
  ),
);

/** Build the write half of the HTTP-backed {@link ReadWrite} client. */
export const makeWriteR2HttpClient = (
  token: R2HttpToken,
  bucketName: Effect.Effect<string>,
  jurisdiction: Effect.Effect<string>,
): WriteBucketClient => {
  const authorize = authorizeWith(token);
  const scope = makeR2HttpScope(token, bucketName, jurisdiction);

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
      options?: R2PutOptions,
    ) =>
      scope.pipe(
        Effect.flatMap(({ accountId, bucketName, cfR2Jurisdiction }) =>
          toBody(value).pipe(
            Effect.flatMap(({ body, contentLength }) => {
              const meta = readHttpMetadata(options);
              return authorize(
                r2.putObject({
                  accountId,
                  bucketName,
                  objectName: key,
                  cfR2Jurisdiction,
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
                  cfR2StorageClass: (
                    options as { storageClass?: string } | undefined
                  )?.storageClass,
                }),
              ).pipe(
                Effect.map(() =>
                  baseObject(key, meta ?? {}, {
                    size: contentLength,
                    customMetadata: (
                      options as
                        | { customMetadata?: Record<string, string> }
                        | undefined
                    )?.customMetadata,
                    storageClass: (
                      options as { storageClass?: string } | undefined
                    )?.storageClass,
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
        Effect.flatMap(({ accountId, bucketName, cfR2Jurisdiction }) =>
          Array.isArray(keys)
            ? authorize(
                r2.deleteObjects({
                  accountId,
                  bucketName,
                  cfR2Jurisdiction,
                  body: keys,
                }),
              )
            : authorize(
                r2.deleteObject({
                  accountId,
                  bucketName,
                  objectName: keys,
                  cfR2Jurisdiction,
                }),
              ),
        ),
        Effect.mapError(toR2Error),
        Effect.asVoid,
      ),
    createMultipartUpload: () =>
      Effect.die(
        new R2Error({
          message:
            "R2BucketBindingHttp does not support multipart uploads over the HTTP API.",
          cause: new Error("unsupported"),
        }),
      ),
    resumeMultipartUpload: () =>
      Effect.die(
        new R2Error({
          message:
            "R2BucketBindingHttp does not support multipart uploads over the HTTP API.",
          cause: new Error("unsupported"),
        }),
      ),
  };
};
