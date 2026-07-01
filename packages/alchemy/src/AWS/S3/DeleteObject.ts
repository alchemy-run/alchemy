import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface DeleteObjectRequest extends Omit<
  S3.DeleteObjectRequest,
  "Bucket"
> {}

/** @binding */
export interface DeleteObject extends Binding.Service<
  DeleteObject,
  "AWS.S3.DeleteObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: DeleteObjectRequest,
    ) => Effect.Effect<S3.DeleteObjectOutput, S3.DeleteObjectError>
  >
> {}
export const DeleteObject = Binding.Service<DeleteObject>(
  "AWS.S3.DeleteObject",
);
