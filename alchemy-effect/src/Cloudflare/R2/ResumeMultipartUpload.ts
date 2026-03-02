import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import { replaceEffectStream } from "../stream.ts";
import type { Bucket } from "./Bucket.ts";
import { BucketBinding } from "./BucketBinding.js";

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

export class ResumeMultipartUpload extends Binding.Service<
  ResumeMultipartUpload,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (key: string, uploadId: string) => Effect.Effect<MultipartUploadClient>
  >
>()("Cloudflare.R2.ResumeMultipartUpload") {}

export const ResumeMultipartUploadLive = Layer.effect(
  ResumeMultipartUpload,
  Effect.gen(function* () {
    const Policy = yield* ResumeMultipartUploadPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (bucket: Bucket) {
      yield* Policy(bucket);
      const r2Bucket = (env as Record<string, runtime.R2Bucket>)[
        bucket.LogicalId
      ];

      return Effect.fn(function* (key: string, uploadId: string) {
        const multipartUpload = r2Bucket.resumeMultipartUpload(key, uploadId);
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

export class ResumeMultipartUploadPolicy extends Binding.Policy<
  ResumeMultipartUploadPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("Cloudflare.R2.ResumeMultipartUpload") {}

export const ResumeMultipartUploadPolicyLive =
  ResumeMultipartUploadPolicy.layer.succeed(BucketBinding);
