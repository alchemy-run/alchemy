import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { replaceEffectStream } from "../stream.ts";
import type { UploadValue } from "./UploadValue.ts";

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

export const makeMultipartUploadClient = (
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
