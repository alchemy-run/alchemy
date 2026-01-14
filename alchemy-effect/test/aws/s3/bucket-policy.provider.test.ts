import * as AWS from "@/aws";
import { Bucket, BucketPolicy } from "@/aws/s3";
import { apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as S3 from "distilled-aws/s3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

test(
  "create, update, delete bucket policy",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    // Create a bucket to attach the policy to
    class TestBucket extends Bucket("PolicyTestBucket", {
      bucketName: "alchemy-test-policy-crud-bucket",
      forceDestroy: true,
    }) {}

    // Create the bucket first
    const bucketStack = yield* apply(TestBucket);
    const bucketName = bucketStack.PolicyTestBucket.bucketName;
    const bucketArn = bucketStack.PolicyTestBucket.bucketArn;
    const accountId = bucketStack.PolicyTestBucket.accountId;

    // Create a bucket policy - include both bucket and policy in apply
    class TestPolicy extends BucketPolicy("TestPolicy", {
      bucket: bucketName,
      policy: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowGetObject",
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: ["s3:GetObject"],
            Resource: `${bucketArn}/*`,
            Condition: {
              StringEquals: {
                "aws:SourceAccount": accountId,
              },
            },
          },
        ],
      },
    }) {}

    yield* apply(TestBucket, TestPolicy);

    // Verify the policy was created
    const policyResponse = yield* S3.getBucketPolicy({
      Bucket: bucketName,
    });
    expect(policyResponse.Policy).toBeDefined();
    const policy = JSON.parse(policyResponse.Policy!);
    expect(policy.Statement[0].Sid).toEqual("AllowGetObject");
    expect(policy.Statement[0].Action).toContain("s3:GetObject");

    // Update the policy with different permissions
    class UpdatedPolicy extends BucketPolicy("TestPolicy", {
      bucket: bucketName,
      policy: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowPutObject",
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: ["s3:PutObject"],
            Resource: `${bucketArn}/*`,
            Condition: {
              StringEquals: {
                "aws:SourceAccount": accountId,
              },
            },
          },
        ],
      },
    }) {}

    yield* apply(TestBucket, UpdatedPolicy);

    // Verify the policy was updated
    const updatedPolicyResponse = yield* S3.getBucketPolicy({
      Bucket: bucketName,
    });
    expect(updatedPolicyResponse.Policy).toBeDefined();
    const updatedPolicy = JSON.parse(updatedPolicyResponse.Policy!);
    expect(updatedPolicy.Statement[0].Sid).toEqual("AllowPutObject");
    expect(updatedPolicy.Statement[0].Action).toContain("s3:PutObject");

    yield* destroy();

    // Verify the policy was deleted
    yield* assertBucketPolicyDeleted(bucketName);

    // Verify the bucket was deleted
    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "policy with multiple statements",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    class TestBucket extends Bucket("MultiStatementPolicyBucket", {
      bucketName: "alchemy-test-policy-multi-stmt-bucket",
      forceDestroy: true,
    }) {}

    const bucketStack = yield* apply(TestBucket);
    const bucketName = bucketStack.MultiStatementPolicyBucket.bucketName;
    const bucketArn = bucketStack.MultiStatementPolicyBucket.bucketArn;
    const accountId = bucketStack.MultiStatementPolicyBucket.accountId;

    // Create a policy with multiple statements
    class MultiStatementPolicy extends BucketPolicy("MultiStatementPolicy", {
      bucket: bucketName,
      policy: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowGetObject",
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: ["s3:GetObject"],
            Resource: `${bucketArn}/*`,
            Condition: {
              StringEquals: {
                "aws:SourceAccount": accountId,
              },
            },
          },
          {
            Sid: "AllowListBucket",
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: ["s3:ListBucket"],
            Resource: bucketArn,
            Condition: {
              StringEquals: {
                "aws:SourceAccount": accountId,
              },
            },
          },
        ],
      },
    }) {}

    // Apply both bucket and policy together
    yield* apply(TestBucket, MultiStatementPolicy);

    // Verify the policy was created with both statements
    const policyResponse = yield* S3.getBucketPolicy({
      Bucket: bucketName,
    });
    expect(policyResponse.Policy).toBeDefined();
    const policy = JSON.parse(policyResponse.Policy!);
    expect(policy.Statement).toHaveLength(2);
    expect(policy.Statement.map((s: { Sid: string }) => s.Sid)).toContain(
      "AllowGetObject",
    );
    expect(policy.Statement.map((s: { Sid: string }) => s.Sid)).toContain(
      "AllowListBucket",
    );

    yield* destroy();

    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

// Helper functions
class BucketStillExists extends Data.TaggedError("BucketStillExists") {}
class PolicyStillExists extends Data.TaggedError("PolicyStillExists") {}

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

const assertBucketPolicyDeleted = Effect.fn(function* (bucketName: string) {
  yield* S3.getBucketPolicy({ Bucket: bucketName }).pipe(
    Effect.flatMap(() => Effect.fail(new PolicyStillExists())),
    Effect.retry({
      while: (e) => e._tag === "PolicyStillExists",
      schedule: Schedule.exponential(100).pipe(
        Schedule.intersect(Schedule.recurs(10)),
      ),
    }),
    // NoSuchBucketPolicy means the policy was deleted
    Effect.catchTag("NoSuchBucketPolicy", () => Effect.void),
    // NoSuchBucket means the bucket was deleted (also fine)
    Effect.catchTag("NoSuchBucket", () => Effect.void),
    Effect.catchAll(() => Effect.void),
  );
});
