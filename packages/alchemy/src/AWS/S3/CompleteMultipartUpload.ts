import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface CompleteMultipartUploadRequest extends Omit<
  S3.CompleteMultipartUploadRequest,
  "Bucket"
> {}

/** @binding */
export interface CompleteMultipartUpload extends Binding.Service<
  CompleteMultipartUpload,
  "AWS.S3.CompleteMultipartUpload",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CompleteMultipartUploadRequest,
    ) => Effect.Effect<
      S3.CompleteMultipartUploadOutput,
      S3.CompleteMultipartUploadError
    >
  >
> {}

export const CompleteMultipartUpload = Binding.Service<CompleteMultipartUpload>(
  "AWS.S3.CompleteMultipartUpload",
);
