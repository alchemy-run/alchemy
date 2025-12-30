import * as Effect from "effect/Effect";

import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import { toEnvKey } from "../../env.ts";
import { declare, type To } from "../../policy.ts";
import { Function } from "../lambda/function.ts";
import { S3Client } from "./client.ts";
import { Bucket } from "./bucket.ts";

export interface GetObject<B = Bucket> extends Capability<
  "AWS.S3.GetObject",
  B
> {}

export const GetObject = Binding<
  <B extends Bucket>(bucket: B) => Binding<Function, GetObject<To<B>>>
>(Function, "AWS.S3.GetObject");

export interface GetObjectOptions {
  key: string;
  versionId?: string;
  range?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: Date;
  ifUnmodifiedSince?: Date;
}

export const getObject = <B extends Bucket>(
  bucket: B,
  options: GetObjectOptions,
) =>
  Effect.gen(function* () {
    yield* declare<GetObject<To<B>>>();
    const s3 = yield* S3Client;
    const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

    return yield* s3.getObject({
      Bucket: bucketName,
      Key: options.key,
      VersionId: options.versionId,
      Range: options.range,
      IfMatch: options.ifMatch,
      IfNoneMatch: options.ifNoneMatch,
      IfModifiedSince: options.ifModifiedSince?.toISOString(),
      IfUnmodifiedSince: options.ifUnmodifiedSince?.toISOString(),
    });
  });

export const getObjectFromLambdaFunction = () =>
  GetObject.provider.succeed({
    attach: ({ source: bucket }) => ({
      env: {
        [toEnvKey(bucket.id, "BUCKET_NAME")]: bucket.attr.bucketName,
        [toEnvKey(bucket.id, "BUCKET_ARN")]: bucket.attr.bucketArn,
      },
      policyStatements: [
        {
          Sid: "GetObject",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:GetObjectVersion"],
          Resource: [`${bucket.attr.bucketArn}/*`],
        },
      ],
    }),
  });
