import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {}

/** @binding */
export interface GetObject extends Binding.Service<
  GetObject,
  "AWS.S3.GetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectRequest,
    ) => Effect.Effect<S3.GetObjectOutput, S3.GetObjectError>
  >
> {}

export const GetObject = Binding.Service<GetObject>("AWS.S3.GetObject");
