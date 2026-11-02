import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type BoundBucket, makeBucketHttpBinding } from "./BindingHttp.ts";
import { ReadBucket, type ReadBucketClient } from "./ReadBucket.ts";

/** Build the read client for a bound bucket. */
export const makeReadBucketClient = ({ bucketName, withS3 }: BoundBucket): ReadBucketClient => ({
  getObject: (request) =>
    bucketName.pipe(Effect.flatMap((Bucket) => withS3(s3.getObject({ ...request, Bucket })))),
  headObject: (request) =>
    bucketName.pipe(Effect.flatMap((Bucket) => withS3(s3.headObject({ ...request, Bucket })))),
  listObjects: (request) =>
    bucketName.pipe(Effect.flatMap((Bucket) => withS3(s3.listObjectsV2({ ...request, Bucket })))),
});

/**
 * S3 implementation of {@link ReadBucket}.
 *
 * @layer
 * @provides Stackit.ObjectStorage.ReadBucket
 */
export const ReadBucketHttp = Layer.effect(
  ReadBucket,
  makeBucketHttpBinding({
    tag: "Stackit.ObjectStorage.ReadBucket",
    level: "Read",
    makeClient: makeReadBucketClient,
  }),
);
