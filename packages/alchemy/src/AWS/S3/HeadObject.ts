import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface HeadObjectRequest extends Omit<
  S3.HeadObjectRequest,
  "Bucket"
> {}

/** @binding */
export interface HeadObject extends Binding.Service<
  HeadObject,
  "AWS.S3.HeadObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: HeadObjectRequest,
    ) => Effect.Effect<S3.HeadObjectOutput, S3.HeadObjectError>
  >
> {}

export const HeadObject = Binding.Service<HeadObject>("AWS.S3.HeadObject");
