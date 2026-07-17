import * as AWS from "@/AWS";
import { CloudTrail } from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Vitest";
import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic out-of-band names (no Date.now — stable across re-runs).
const bucketName = "alchemy-test-cloudtrail-bucket";
const trailName = "alchemy-test-cloudtrail-trail";

// CloudTrail requires the destination bucket to authorize
// cloudtrail.amazonaws.com to check the ACL and write log objects under
// AWSLogs/<accountId>/*.
const trailBucketPolicy = (accountId: string) => {
  const bucketArn = `arn:aws:s3:::${bucketName}`;
  return [
    {
      Sid: "AWSCloudTrailAclCheck",
      Effect: "Allow" as const,
      Principal: { Service: "cloudtrail.amazonaws.com" },
      Action: ["s3:GetBucketAcl"],
      Resource: [bucketArn],
    },
    {
      Sid: "AWSCloudTrailWrite",
      Effect: "Allow" as const,
      Principal: { Service: "cloudtrail.amazonaws.com" },
      Action: ["s3:PutObject"],
      Resource: [`${bucketArn}/AWSLogs/${accountId}/*`],
      Condition: {
        StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control" },
      },
    },
  ];
};

test.provider(
  "trail create, start/stop logging, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId } = yield* AWSEnvironment.current;

      // Deploy the destination bucket (with CloudTrail policy) + a logging trail.
      const { trail } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("TrailBucket", {
            bucketName,
            forceDestroy: true,
            policy: trailBucketPolicy(accountId),
          });
          const trail = yield* CloudTrail.Trail("Trail", {
            trailName,
            s3BucketName: bucket.bucketName,
            enableLogFileValidation: true,
            includeGlobalServiceEvents: true,
          });
          return { trail };
        }),
      );

      expect(trail.trailName).toEqual(trailName);
      expect(trail.trailArn).toContain(`:trail/${trailName}`);

      // Out-of-band: the trail exists and log file validation is on.
      const got = yield* cloudtrail.getTrail({ Name: trailName });
      expect(got.Trail?.LogFileValidationEnabled).toBe(true);
      expect(got.Trail?.S3BucketName).toEqual(bucketName);

      // Logging is enabled by default — poll until CloudTrail reports it.
      const logging = yield* cloudtrail
        .getTrailStatus({ Name: trailName })
        .pipe(
          Effect.map((s) => s.IsLogging ?? false),
          // poll the SUCCESS value until it flips — repeat, not retry
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (isLogging) => isLogging === true,
            times: 15,
          }),
        );
      expect(logging).toBe(true);

      // Update: stop logging by flipping enableLogging.
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("TrailBucket", {
            bucketName,
            forceDestroy: true,
            policy: trailBucketPolicy(accountId),
          });
          const trail = yield* CloudTrail.Trail("Trail", {
            trailName,
            s3BucketName: bucket.bucketName,
            enableLogFileValidation: true,
            includeGlobalServiceEvents: true,
            enableLogging: false,
          });
          return { trail };
        }),
      );

      const stopped = yield* cloudtrail
        .getTrailStatus({ Name: trailName })
        .pipe(
          Effect.map((s) => s.IsLogging ?? false),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (isLogging) => isLogging === false,
            times: 15,
          }),
        );
      expect(stopped).toBe(false);

      yield* stack.destroy();

      // Out-of-band: the trail is gone.
      yield* cloudtrail.getTrail({ Name: trailName }).pipe(
        Effect.flatMap(() => Effect.fail(new Error("trail still exists"))),
        Effect.retry({
          while: (e) => e instanceof Error,
          schedule: Schedule.max([
            Schedule.exponential(200),
            Schedule.recurs(8),
          ]),
        }),
        Effect.catchTag("TrailNotFoundException", () => Effect.void),
        Effect.catch(() => Effect.void),
      );
    }),
  { timeout: 180_000 },
);
