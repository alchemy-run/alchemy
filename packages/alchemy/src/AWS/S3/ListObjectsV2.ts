import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface ListObjectsV2Request extends Omit<
  S3.ListObjectsV2Request,
  "Bucket"
> {}

/** @binding */
export interface ListObjectsV2 extends Binding.Service<
  ListObjectsV2,
  "AWS.S3.ListObjectsV2",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: ListObjectsV2Request,
    ) => Effect.Effect<S3.ListObjectsV2Output, S3.ListObjectsV2Error>
  >
> {}

export const ListObjectsV2 = Binding.Service<ListObjectsV2>(
  "AWS.S3.ListObjectsV2",
);
