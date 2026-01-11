import * as Effect from "effect/Effect";

import * as S3 from "distilled-aws/s3";
import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import { toEnvKey } from "../../env.ts";
import { declare, type To } from "../../policy.ts";
import { Function } from "../lambda/function.ts";
import { Bucket } from "./bucket.ts";

export interface PutObject<B = Bucket> extends Capability<
  "AWS.S3.PutObject",
  B
> {}

export const PutObject = Binding<
  <B extends Bucket>(bucket: B) => Binding<Function, PutObject<To<B>>>
>(Function, "AWS.S3.PutObject");

export interface PutObjectOptions {
  key: string;
  body: string | Buffer | Uint8Array;
  contentType?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  storageClass?:
    | "STANDARD"
    | "REDUCED_REDUNDANCY"
    | "STANDARD_IA"
    | "ONEZONE_IA"
    | "INTELLIGENT_TIERING"
    | "GLACIER"
    | "DEEP_ARCHIVE"
    | "GLACIER_IR";
  serverSideEncryption?: "AES256" | "aws:kms" | "aws:kms:dsse";
  sseKmsKeyId?: string;
  tagging?: string;
}

export const putObject = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  options: PutObjectOptions,
) {
  yield* declare<PutObject<To<B>>>();
  const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

  return yield* S3.putObject({
    Bucket: bucketName,
    Key: options.key,
    Body: options.body,
    ContentType: options.contentType,
    ContentEncoding: options.contentEncoding,
    ContentDisposition: options.contentDisposition,
    CacheControl: options.cacheControl,
    Metadata: options.metadata,
    StorageClass: options.storageClass,
    ServerSideEncryption: options.serverSideEncryption,
    SSEKMSKeyId: options.sseKmsKeyId,
    Tagging: options.tagging,
  });
});

export const putObjectFromLambdaFunction = () =>
  PutObject.provider.succeed({
    attach: ({ source: bucket }) => ({
      env: {
        [toEnvKey(bucket.id, "BUCKET_NAME")]: bucket.attr.bucketName,
        [toEnvKey(bucket.id, "BUCKET_ARN")]: bucket.attr.bucketArn,
      },
      policyStatements: [
        {
          Sid: "PutObject",
          Effect: "Allow",
          Action: ["s3:PutObject"],
          Resource: [`${bucket.attr.bucketArn}/*`],
        },
      ],
    }),
  });
