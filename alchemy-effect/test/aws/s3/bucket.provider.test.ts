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
    class TestBucket extends Bucket("TestBucket", {
      tags: { Environment: "test" },
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
      tags: { Environment: "production", Team: "platform" },
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
    class CustomNameBucket extends Bucket("CustomNameBucket", {
      bucketName: "alchemy-test-custom-name-bucket",
    }) {}

    const stack = yield* apply(CustomNameBucket);

    expect(stack.CustomNameBucket.bucketName).toEqual(
      "alchemy-test-custom-name-bucket",
    );
    expect(stack.CustomNameBucket.bucketArn).toEqual(
      "arn:aws:s3:::alchemy-test-custom-name-bucket",
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
    class ForceDestroyBucket extends Bucket("ForceDestroyBucket", {
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
    class IdempotentBucket extends Bucket("IdempotentBucket", {
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
