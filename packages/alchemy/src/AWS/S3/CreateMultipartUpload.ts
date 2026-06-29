import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface CreateMultipartUploadRequest extends Omit<
  S3.CreateMultipartUploadRequest,
  "Bucket"
> {}

/** @binding */
export interface CreateMultipartUpload extends Binding.Service<
  CreateMultipartUpload,
  "AWS.S3.CreateMultipartUpload",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CreateMultipartUploadRequest,
    ) => Effect.Effect<
      S3.CreateMultipartUploadOutput,
      S3.CreateMultipartUploadError
    >
  >
> {}

export const CreateMultipartUpload = Binding.Service<CreateMultipartUpload>(
  "AWS.S3.CreateMultipartUpload",
);
