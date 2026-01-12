import * as Effect from "effect/Effect";

import * as S3 from "distilled-aws/s3";
import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import { toEnvKey } from "../../env.ts";
import { declare, type To } from "../../policy.ts";
import { Function } from "../lambda/function.ts";
import { Bucket } from "./bucket.ts";

// ============================================================================
// MultipartUpload Capability (covers create, upload part, complete, abort)
// ============================================================================

export interface MultipartUpload<B = Bucket>
  extends Capability<"AWS.S3.MultipartUpload", B> {}

export const MultipartUpload = Binding<
  <B extends Bucket>(bucket: B) => Binding<Function, MultipartUpload<To<B>>>
>(Function, "AWS.S3.MultipartUpload");

// ============================================================================
// CreateMultipartUpload
// ============================================================================

export interface CreateMultipartUploadOptions {
  key: string;
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

export const createMultipartUpload = Effect.fnUntraced(function* <
  B extends Bucket,
>(bucket: B, options: CreateMultipartUploadOptions) {
  yield* declare<MultipartUpload<To<B>>>();
  const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

  return yield* S3.createMultipartUpload({
    Bucket: bucketName,
    Key: options.key,
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

// ============================================================================
// UploadPart
// ============================================================================

export interface UploadPartOptions {
  key: string;
  uploadId: string;
  partNumber: number;
  body: string | Buffer | Uint8Array;
  contentLength?: number;
  contentMD5?: string;
}

export const uploadPart = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  options: UploadPartOptions,
) {
  yield* declare<MultipartUpload<To<B>>>();
  const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

  return yield* S3.uploadPart({
    Bucket: bucketName,
    Key: options.key,
    UploadId: options.uploadId,
    PartNumber: options.partNumber,
    Body: options.body,
    ContentLength: options.contentLength,
    ContentMD5: options.contentMD5,
  });
});

// ============================================================================
// CompleteMultipartUpload
// ============================================================================

export interface CompletedPart {
  etag: string;
  partNumber: number;
}

export interface CompleteMultipartUploadOptions {
  key: string;
  uploadId: string;
  parts: CompletedPart[];
}

export const completeMultipartUpload = Effect.fnUntraced(function* <
  B extends Bucket,
>(bucket: B, options: CompleteMultipartUploadOptions) {
  yield* declare<MultipartUpload<To<B>>>();
  const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

  return yield* S3.completeMultipartUpload({
    Bucket: bucketName,
    Key: options.key,
    UploadId: options.uploadId,
    MultipartUpload: {
      Parts: options.parts.map((part) => ({
        ETag: part.etag,
        PartNumber: part.partNumber,
      })),
    },
  });
});

// ============================================================================
// AbortMultipartUpload
// ============================================================================

export interface AbortMultipartUploadOptions {
  key: string;
  uploadId: string;
}

export const abortMultipartUpload = Effect.fnUntraced(function* <
  B extends Bucket,
>(bucket: B, options: AbortMultipartUploadOptions) {
  yield* declare<MultipartUpload<To<B>>>();
  const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

  return yield* S3.abortMultipartUpload({
    Bucket: bucketName,
    Key: options.key,
    UploadId: options.uploadId,
  });
});

// ============================================================================
// Provider
// ============================================================================

export const multipartUploadFromLambdaFunction = () =>
  MultipartUpload.provider.succeed({
    attach: ({ source: bucket }) => ({
      env: {
        [toEnvKey(bucket.id, "BUCKET_NAME")]: bucket.attr.bucketName,
        [toEnvKey(bucket.id, "BUCKET_ARN")]: bucket.attr.bucketArn,
      },
      policyStatements: [
        {
          Sid: "MultipartUpload",
          Effect: "Allow",
          Action: [
            "s3:PutObject",
            "s3:AbortMultipartUpload",
            "s3:ListMultipartUploadParts",
          ],
          Resource: [`${bucket.attr.bucketArn}/*`],
        },
      ],
    }),
  });
