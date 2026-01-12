import * as Effect from "effect/Effect";

import * as S3 from "distilled-aws/s3";
import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import { toEnvKey } from "../../env.ts";
import { declare, type To } from "../../policy.ts";
import { Function } from "../lambda/function.ts";
import { Bucket } from "./bucket.ts";

export interface CopyObject<B = Bucket>
  extends Capability<"AWS.S3.CopyObject", B> {}

export const CopyObject = Binding<
  <B extends Bucket>(bucket: B) => Binding<Function, CopyObject<To<B>>>
>(Function, "AWS.S3.CopyObject");

export interface CopyObjectOptions {
  /** The key for the destination object */
  key: string;
  /**
   * The source object to copy from.
   * Format: "bucket-name/key" or "/bucket-name/key"
   * For versioned objects: "bucket-name/key?versionId=version-id"
   */
  copySource: string;
  contentType?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  metadataDirective?: "COPY" | "REPLACE";
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
  taggingDirective?: "COPY" | "REPLACE";
}

export const copyObject = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  options: CopyObjectOptions,
) {
  yield* declare<CopyObject<To<B>>>();
  const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

  return yield* S3.copyObject({
    Bucket: bucketName,
    Key: options.key,
    CopySource: options.copySource,
    ContentType: options.contentType,
    ContentEncoding: options.contentEncoding,
    ContentDisposition: options.contentDisposition,
    CacheControl: options.cacheControl,
    Metadata: options.metadata,
    MetadataDirective: options.metadataDirective,
    StorageClass: options.storageClass,
    ServerSideEncryption: options.serverSideEncryption,
    SSEKMSKeyId: options.sseKmsKeyId,
    Tagging: options.tagging,
    TaggingDirective: options.taggingDirective,
  });
});

export const copyObjectFromLambdaFunction = () =>
  CopyObject.provider.succeed({
    attach: ({ source: bucket }) => ({
      env: {
        [toEnvKey(bucket.id, "BUCKET_NAME")]: bucket.attr.bucketName,
        [toEnvKey(bucket.id, "BUCKET_ARN")]: bucket.attr.bucketArn,
      },
      policyStatements: [
        {
          Sid: "CopyObject",
          Effect: "Allow",
          Action: ["s3:PutObject", "s3:GetObject"],
          Resource: [`${bucket.attr.bucketArn}/*`],
        },
      ],
    }),
  });
