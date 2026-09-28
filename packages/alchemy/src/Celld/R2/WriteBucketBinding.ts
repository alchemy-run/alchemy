import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  makeR2BucketBinding,
  type makeR2BucketHelpers,
  validateR2Options,
} from "./BucketBinding.ts";
import type {
  BucketValue,
  MultipartUpload,
  NativeMultipartUpload,
  PutOptions,
} from "./BucketTypes.ts";
import { WriteBucket, type WriteBucketClient } from "./WriteBucket.ts";

/**
 * Native Celld R2 writes, including streams without a content-length requirement.
 *
 * @layer
 * @provides Celld.R2.WriteBucket
 * @product R2
 */
export const WriteBucketBinding = Layer.effect(
  WriteBucket,
  Effect.suspend(() =>
    makeR2BucketBinding({ makeClient: makeWriteBucketClient }),
  ),
);

/** Build the write half of the native bucket client. */
export const makeWriteBucketClient = ({
  raw,
  use,
  tryPromise,
  trySync,
  wrapR2Object,
}: ReturnType<typeof makeR2BucketHelpers>): WriteBucketClient => {
  const wrapMultipart = (upload: NativeMultipartUpload): MultipartUpload => ({
    raw: upload,
    key: upload.key,
    get uploadId() {
      return upload.uploadId;
    },
    abort: () => tryPromise(() => upload.abort()),
    complete: (parts) =>
      tryPromise(() => upload.complete(parts)).pipe(Effect.map(wrapR2Object)),
    uploadPart: (partNumber, value, options) =>
      tryPromise(() => {
        validateR2Options(options);
        return upload.uploadPart(
          partNumber,
          Stream.isStream(value) ? Stream.toReadableStream(value) : value,
          options,
        );
      }),
  });
  return {
    put: (<Err>(
      key: string,
      value: BucketValue | Stream.Stream<Uint8Array, Err>,
      options?: PutOptions,
    ) =>
      use((binding) => {
        validateR2Options(options);
        const { contentLength: _, ...nativeOptions } = options ?? {};
        return binding.put(
          key,
          Stream.isStream(value) ? Stream.toReadableStream(value) : value,
          nativeOptions,
        );
      }).pipe(
        Effect.map((object) => (object === null ? null : wrapR2Object(object))),
      )) as WriteBucketClient["put"],
    delete: (keys) => use((binding) => binding.delete(keys)),
    createMultipartUpload: (key, options) =>
      use((binding) => {
        validateR2Options(options);
        return binding.createMultipartUpload(key, options);
      }).pipe(Effect.map(wrapMultipart)),
    resumeMultipartUpload: (key, uploadId) =>
      raw.pipe(
        Effect.flatMap((binding) =>
          trySync(() => binding.resumeMultipartUpload(key, uploadId)),
        ),
        Effect.map(wrapMultipart),
      ),
  };
};
