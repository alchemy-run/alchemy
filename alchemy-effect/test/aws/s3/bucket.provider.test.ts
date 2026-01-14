import * as AWS from "@/aws";
import { Bucket } from "@/aws/s3";
import { apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as S3 from "distilled-aws/s3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

test(
  "create, update, delete bucket",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    class TestBucket extends Bucket("TestBucket", {
      bucketName: "alchemy-test-bucket-crud",
      tags: { Environment: "test" },
      forceDestroy: true,
    }) {}

    const stack = yield* apply(TestBucket);

    // Verify the bucket was created
    yield* S3.headBucket({ Bucket: stack.TestBucket.bucketName });

    // Verify tags
    const tagging = yield* S3.getBucketTagging({
      Bucket: stack.TestBucket.bucketName,
    });
    expect(tagging.TagSet).toContainEqual({
      Key: "Environment",
      Value: "test",
    });

    // Update the bucket tags
    class UpdatedBucket extends Bucket("TestBucket", {
      bucketName: "alchemy-test-bucket-crud",
      tags: { Environment: "production", Team: "platform" },
      forceDestroy: true,
    }) {}

    yield* apply(UpdatedBucket);

    // Verify tags were updated
    const updatedTagging = yield* S3.getBucketTagging({
      Bucket: stack.TestBucket.bucketName,
    });
    expect(updatedTagging.TagSet).toContainEqual({
      Key: "Environment",
      Value: "production",
    });
    expect(updatedTagging.TagSet).toContainEqual({
      Key: "Team",
      Value: "platform",
    });

    yield* destroy();

    yield* assertBucketDeleted(stack.TestBucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create bucket with custom name",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    class CustomNameBucket extends Bucket("CustomNameBucket", {
      bucketName: "alchemy-test-bucket-custom-name",
      forceDestroy: true,
    }) {}

    const stack = yield* apply(CustomNameBucket);

    expect(stack.CustomNameBucket.bucketName).toEqual(
      "alchemy-test-bucket-custom-name",
    );
    expect(stack.CustomNameBucket.bucketArn).toEqual(
      "arn:aws:s3:::alchemy-test-bucket-custom-name",
    );

    // Verify the bucket exists
    yield* S3.headBucket({ Bucket: stack.CustomNameBucket.bucketName });

    yield* destroy();

    yield* assertBucketDeleted(stack.CustomNameBucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create bucket with forceDestroy",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    class ForceDestroyBucket extends Bucket("ForceDestroyBucket", {
      bucketName: "alchemy-test-bucket-force-destroy",
      forceDestroy: true,
    }) {}

    const stack = yield* apply(ForceDestroyBucket);

    // Put an object in the bucket
    yield* S3.putObject({
      Bucket: stack.ForceDestroyBucket.bucketName,
      Key: "test-object.txt",
      Body: "Hello, World!",
    });

    // Verify the object exists
    yield* S3.headObject({
      Bucket: stack.ForceDestroyBucket.bucketName,
      Key: "test-object.txt",
    });

    // Destroy should succeed even with objects in the bucket
    yield* destroy();

    yield* assertBucketDeleted(stack.ForceDestroyBucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "idempotent create - bucket already exists",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    class IdempotentBucket extends Bucket("IdempotentBucket", {
      bucketName: "alchemy-test-bucket-idempotent",
      forceDestroy: true,
    }) {}

    // First create
    const stack1 = yield* apply(IdempotentBucket);
    const bucketName = stack1.IdempotentBucket.bucketName;

    // Second create (should be idempotent)
    const stack2 = yield* apply(IdempotentBucket);
    expect(stack2.IdempotentBucket.bucketName).toEqual(bucketName);

    yield* destroy();

    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create bucket with objectLockEnabled",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    class ObjectLockBucket extends Bucket("ObjectLockBucket", {
      bucketName: "alchemy-test-bucket-object-lock",
      objectLockEnabled: true,
      forceDestroy: true,
    }) {}

    const stack = yield* apply(ObjectLockBucket);

    // Verify Object Lock is enabled
    const objectLockConfig = yield* S3.getObjectLockConfiguration({
      Bucket: stack.ObjectLockBucket.bucketName,
    });
    expect(objectLockConfig.ObjectLockConfiguration?.ObjectLockEnabled).toEqual(
      "Enabled",
    );

    yield* destroy();

    yield* assertBucketDeleted(stack.ObjectLockBucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "remove all tags from bucket",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    // Create bucket with tags
    class TaggedBucket extends Bucket("TagRemovalBucket", {
      bucketName: "alchemy-test-bucket-tag-removal",
      tags: { Environment: "test", Team: "platform" },
      forceDestroy: true,
    }) {}

    const stack = yield* apply(TaggedBucket);
    const bucketName = stack.TagRemovalBucket.bucketName;

    // Verify tags exist
    const tagging = yield* S3.getBucketTagging({
      Bucket: bucketName,
    });
    expect(tagging.TagSet).toHaveLength(2);

    // Update to remove all tags
    class UntaggedBucket extends Bucket("TagRemovalBucket", {
      bucketName: "alchemy-test-bucket-tag-removal",
      forceDestroy: true,
    }) {}

    yield* apply(UntaggedBucket);

    // Verify all tags were removed (NoSuchTagSet error expected)
    const result = yield* S3.getBucketTagging({
      Bucket: bucketName,
    }).pipe(
      Effect.map(() => "has-tags" as const),
      Effect.catchTag("NoSuchTagSet", () => Effect.succeed("no-tags" as const)),
    );
    expect(result).toEqual("no-tags");

    yield* destroy();

    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

const assertBucketDeleted = Effect.fn(function* (bucketName: string) {
  yield* S3.headBucket({ Bucket: bucketName }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.exponential(100).pipe(
        Schedule.intersect(Schedule.recurs(10)),
      ),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catchAll(() => Effect.void),
  );
});
