import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface AbortMultipartUploadRequest extends Omit<
  S3.AbortMultipartUploadRequest,
  "Bucket"
> {}

/** @binding */
export interface AbortMultipartUpload extends Binding.Service<
  AbortMultipartUpload,
  "AWS.S3.AbortMultipartUpload",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: AbortMultipartUploadRequest,
    ) => Effect.Effect<
      S3.AbortMultipartUploadOutput,
      S3.AbortMultipartUploadError
    >
  >
> {}

export const AbortMultipartUpload = Binding.Service<AbortMultipartUpload>(
  "AWS.S3.AbortMultipartUpload",
);
