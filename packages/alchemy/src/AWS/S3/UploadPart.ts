import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface UploadPartRequest extends Omit<
  S3.UploadPartRequest,
  "Bucket"
> {}

/** @binding */
export interface UploadPart extends Binding.Service<
  UploadPart,
  "AWS.S3.UploadPart",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: UploadPartRequest,
    ) => Effect.Effect<S3.UploadPartOutput, S3.UploadPartError>
  >
> {}
export const UploadPart = Binding.Service<UploadPart>("AWS.S3.UploadPart");
