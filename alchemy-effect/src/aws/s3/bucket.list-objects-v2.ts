import * as Effect from "effect/Effect";

import * as S3 from "distilled-aws/s3";
import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import { toEnvKey } from "../../env.ts";
import { declare, type To } from "../../policy.ts";
import { Function } from "../lambda/function.ts";
import { Bucket } from "./bucket.ts";

export interface ListObjectsV2<B = Bucket> extends Capability<
  "AWS.S3.ListObjectsV2",
  B
> {}

export const ListObjectsV2 = Binding<
  <B extends Bucket>(bucket: B) => Binding<Function, ListObjectsV2<To<B>>>
>(Function, "AWS.S3.ListObjectsV2");

export interface ListObjectsV2Options {
  prefix?: string;
  delimiter?: string;
  maxKeys?: number;
  continuationToken?: string;
  startAfter?: string;
  fetchOwner?: boolean;
}

export const listObjectsV2 = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  options?: ListObjectsV2Options,
) {
  yield* declare<ListObjectsV2<To<B>>>();
  const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

  return yield* S3.listObjectsV2({
    Bucket: bucketName,
    Prefix: options?.prefix,
    Delimiter: options?.delimiter,
    MaxKeys: options?.maxKeys,
    ContinuationToken: options?.continuationToken,
    StartAfter: options?.startAfter,
    FetchOwner: options?.fetchOwner,
  });
});

export const listObjectsV2FromLambdaFunction = () =>
  ListObjectsV2.provider.succeed({
    attach: ({ source: bucket }) => ({
      env: {
        [toEnvKey(bucket.id, "BUCKET_NAME")]: bucket.attr.bucketName,
        [toEnvKey(bucket.id, "BUCKET_ARN")]: bucket.attr.bucketArn,
      },
      policyStatements: [
        {
          Sid: "ListObjectsV2",
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [bucket.attr.bucketArn],
        },
      ],
    }),
  });
