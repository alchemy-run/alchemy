// @ts-nocheck
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface CopyObjectRequest extends Omit<
  S3.CopyObjectRequest,
  "Bucket"
> {}

/** @binding */
export interface CopyObject extends Binding.Service<
  CopyObject,
  "AWS.S3.CopyObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CopyObjectRequest,
    ) => Effect.Effect<S3.CopyObjectOutput, S3.CopyObjectError>
  >
> {}

export const CopyObject = Binding.Service<CopyObject>("AWS.S3.CopyObject");
