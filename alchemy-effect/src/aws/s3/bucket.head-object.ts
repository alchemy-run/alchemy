import * as Effect from "effect/Effect";

import * as S3 from "distilled-aws/s3";
import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import { toEnvKey } from "../../env.ts";
import { declare, type To } from "../../policy.ts";
import { Function } from "../lambda/function.ts";
import { Bucket } from "./bucket.ts";

export interface HeadObject<B = Bucket>
  extends Capability<"AWS.S3.HeadObject", B> {}

export const HeadObject = Binding<
  <B extends Bucket>(bucket: B) => Binding<Function, HeadObject<To<B>>>
>(Function, "AWS.S3.HeadObject");

export interface HeadObjectOptions {
  key: string;
  versionId?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: Date;
  ifUnmodifiedSince?: Date;
  range?: string;
  partNumber?: number;
}

export const headObject = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  options: HeadObjectOptions,
) {
  yield* declare<HeadObject<To<B>>>();
  const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

  return yield* S3.headObject({
    Bucket: bucketName,
    Key: options.key,
    VersionId: options.versionId,
    IfMatch: options.ifMatch,
    IfNoneMatch: options.ifNoneMatch,
    IfModifiedSince: options.ifModifiedSince,
    IfUnmodifiedSince: options.ifUnmodifiedSince,
    Range: options.range,
    PartNumber: options.partNumber,
  });
});

export const headObjectFromLambdaFunction = () =>
  HeadObject.provider.succeed({
    attach: ({ source: bucket }) => ({
      env: {
        [toEnvKey(bucket.id, "BUCKET_NAME")]: bucket.attr.bucketName,
        [toEnvKey(bucket.id, "BUCKET_ARN")]: bucket.attr.bucketArn,
      },
      policyStatements: [
        {
          Sid: "HeadObject",
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: [`${bucket.attr.bucketArn}/*`],
        },
      ],
    }),
  });
