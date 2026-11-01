import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type BoundBucket, makeBucketHttpBinding } from "./BindingHttp.ts";
import { WriteBucket, type WriteBucketClient } from "./WriteBucket.ts";

/** Build the write client for a bound bucket. */
export const makeWriteBucketClient = ({ bucketName, withS3 }: BoundBucket): WriteBucketClient => ({
  putObject: (request) =>
    bucketName.pipe(Effect.flatMap((Bucket) => withS3(s3.putObject({ ...request, Bucket })))),
  deleteObject: (request) =>
    bucketName.pipe(Effect.flatMap((Bucket) => withS3(s3.deleteObject({ ...request, Bucket })))),
  deleteObjects: (request) =>
    bucketName.pipe(Effect.flatMap((Bucket) => withS3(s3.deleteObjects({ ...request, Bucket })))),
  createMultipartUpload: (request) =>
    bucketName.pipe(
      Effect.flatMap((Bucket) => withS3(s3.createMultipartUpload({ ...request, Bucket }))),
    ),
  uploadPart: (request) =>
    bucketName.pipe(Effect.flatMap((Bucket) => withS3(s3.uploadPart({ ...request, Bucket })))),
  listParts: (request) =>
    bucketName.pipe(Effect.flatMap((Bucket) => withS3(s3.listParts({ ...request, Bucket })))),
  completeMultipartUpload: (request) =>
    bucketName.pipe(
      Effect.flatMap((Bucket) => withS3(s3.completeMultipartUpload({ ...request, Bucket }))),
    ),
  abortMultipartUpload: (request) =>
    bucketName.pipe(
      Effect.flatMap((Bucket) => withS3(s3.abortMultipartUpload({ ...request, Bucket }))),
    ),
});

/**
 * S3 implementation of {@link WriteBucket}.
 *
 * @layer
 * @provides Stackit.ObjectStorage.WriteBucket
 */
export const WriteBucketHttp = Layer.effect(
  WriteBucket,
  makeBucketHttpBinding({
    tag: "Stackit.ObjectStorage.WriteBucket",
    level: "Write",
    makeClient: makeWriteBucketClient,
  }),
);
