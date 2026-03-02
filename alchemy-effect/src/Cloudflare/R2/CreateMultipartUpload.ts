import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import { replaceEffectStream } from "../stream.ts";
import type { Bucket } from "./Bucket.ts";
import { BucketBinding } from "./BucketBinding.ts";

export type UploadValue =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | runtime.Blob
  | runtime.ReadableStream
  | Stream.Stream<any>;

export interface MultipartUploadClient {
  key: string;
  uploadId: string;
  uploadPart: (
    partNumber: number,
    value: UploadValue,
    options?: runtime.R2UploadPartOptions,
  ) => Effect.Effect<runtime.R2UploadedPart>;
  abort: () => Effect.Effect<void>;
  complete: (
    uploadedParts: runtime.R2UploadedPart[],
  ) => Effect.Effect<runtime.R2Object>;
}

export interface CreateMultipartUploadOptions
  extends runtime.R2MultipartOptions {}

export class CreateMultipartUpload extends Binding.Service<
  CreateMultipartUpload,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      key: string,
      options?: CreateMultipartUploadOptions,
    ) => Effect.Effect<MultipartUploadClient>
  >
>()("Cloudflare.R2.CreateMultipartUpload") {}

export const CreateMultipartUploadLive = Layer.effect(
  CreateMultipartUpload,
  Effect.gen(function* () {
    const Policy = yield* CreateMultipartUploadPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (bucket: Bucket) {
      yield* Policy(bucket);
      const r2Bucket = (env as Record<string, runtime.R2Bucket>)[
        bucket.LogicalId
      ];

      return Effect.fn(function* (
        key: string,
        options?: CreateMultipartUploadOptions,
      ) {
        const multipartUpload = yield* Effect.promise(() =>
          r2Bucket.createMultipartUpload(key, options),
        );
        return makeMultipartUploadClient(multipartUpload);
      });
    });
  }),
);

const makeMultipartUploadClient = (
  multipartUpload: runtime.R2MultipartUpload,
): MultipartUploadClient => ({
  key: multipartUpload.key,
  uploadId: multipartUpload.uploadId,
  uploadPart: (
    partNumber: number,
    value: UploadValue,
    options?: runtime.R2UploadPartOptions,
  ) =>
    Effect.promise(() =>
      multipartUpload.uploadPart(
        partNumber,
        replaceEffectStream(value),
        options,
      ),
    ),
  abort: () => Effect.promise(() => multipartUpload.abort()),
  complete: (uploadedParts: runtime.R2UploadedPart[]) =>
    Effect.promise(() => multipartUpload.complete(uploadedParts)),
});

export class CreateMultipartUploadPolicy extends Binding.Policy<
  CreateMultipartUploadPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("Cloudflare.R2.CreateMultipartUpload") {}

export const CreateMultipartUploadPolicyLive =
  CreateMultipartUploadPolicy.layer.succeed(BucketBinding);
