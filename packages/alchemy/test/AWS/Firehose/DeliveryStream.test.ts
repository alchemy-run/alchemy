import * as AWS from "@/AWS";
import { DeliveryStream } from "@/AWS/Firehose";
import * as Test from "@/Test/Vitest";
import * as Firehose from "@distilled.cloud/aws/firehose";
import * as iam from "@distilled.cloud/aws/iam";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe.skipIf(!!process.env.FAST)("AWS.Firehose.DeliveryStream", () => {
  test.provider(
    "create DirectPut stream to S3, update destination settings, destroy",
    (stack) =>
      Effect.gen(function* () {
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* AWS.S3.Bucket("FirehoseTestBucket", {
              forceDestroy: true,
            });
            const stream = yield* DeliveryStream("TestDeliveryStream", {
              destination: {
                bucketArn: bucket.bucketArn,
              },
              tags: { Environment: "test" },
            });
            return { bucket, stream };
          }),
        );

        expect(initial.stream.deliveryStreamName).toBeDefined();
        expect(initial.stream.deliveryStreamStatus).toEqual("ACTIVE");
        expect(initial.stream.deliveryStreamType).toEqual("DirectPut");
        expect(initial.stream.bucketArn).toEqual(initial.bucket.bucketArn);
        expect(initial.stream.roleArn).toContain(":role/");
        expect(initial.stream.roleName).toBeDefined();
        // AWS defaults applied when no buffering hints are provided.
        expect(initial.stream.bufferingIntervalInSeconds).toEqual(300);
        expect(initial.stream.bufferingSizeInMBs).toEqual(5);
        expect(initial.stream.compressionFormat).toEqual("UNCOMPRESSED");

        // Out-of-band verification via distilled.
        const described = yield* Firehose.describeDeliveryStream({
          DeliveryStreamName: initial.stream.deliveryStreamName,
        });
        const description = described.DeliveryStreamDescription;
        expect(description.DeliveryStreamStatus).toEqual("ACTIVE");
        expect(description.DeliveryStreamType).toEqual("DirectPut");
        expect(
          description.Destinations[0]?.ExtendedS3DestinationDescription
            ?.BucketARN,
        ).toEqual(initial.bucket.bucketArn);

        // Ownership + user tags.
        const tags = yield* Firehose.listTagsForDeliveryStream({
          DeliveryStreamName: initial.stream.deliveryStreamName,
        });
        const tagKeys = tags.Tags.map((tag) => tag.Key);
        expect(tagKeys).toContain("alchemy::stack");
        expect(tagKeys).toContain("alchemy::stage");
        expect(tagKeys).toContain("alchemy::id");
        expect(tags.Tags).toContainEqual({
          Key: "Environment",
          Value: "test",
        });

        // Update destination settings in place (UpdateDestination path).
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* AWS.S3.Bucket("FirehoseTestBucket", {
              forceDestroy: true,
            });
            const stream = yield* DeliveryStream("TestDeliveryStream", {
              destination: {
                bucketArn: bucket.bucketArn,
                prefix: "events/",
                errorOutputPrefix: "errors/",
                bufferingIntervalInSeconds: 60,
                bufferingSizeInMBs: 1,
                compressionFormat: "GZIP",
              },
              tags: { Environment: "production", Team: "platform" },
            });
            return { bucket, stream };
          }),
        );

        // Same physical stream — updated in place, not replaced.
        expect(updated.stream.deliveryStreamName).toEqual(
          initial.stream.deliveryStreamName,
        );
        expect(updated.stream.prefix).toEqual("events/");
        expect(updated.stream.errorOutputPrefix).toEqual("errors/");
        expect(updated.stream.bufferingIntervalInSeconds).toEqual(60);
        expect(updated.stream.bufferingSizeInMBs).toEqual(1);
        expect(updated.stream.compressionFormat).toEqual("GZIP");

        const updatedDescription = yield* Firehose.describeDeliveryStream({
          DeliveryStreamName: initial.stream.deliveryStreamName,
        });
        const s3Description =
          updatedDescription.DeliveryStreamDescription.Destinations[0]
            ?.ExtendedS3DestinationDescription;
        expect(s3Description?.Prefix).toEqual("events/");
        expect(s3Description?.BufferingHints.IntervalInSeconds).toEqual(60);
        expect(s3Description?.BufferingHints.SizeInMBs).toEqual(1);
        expect(s3Description?.CompressionFormat).toEqual("GZIP");

        // Updated tags converged.
        const updatedTags = yield* Firehose.listTagsForDeliveryStream({
          DeliveryStreamName: initial.stream.deliveryStreamName,
        });
        expect(updatedTags.Tags).toContainEqual({
          Key: "Environment",
          Value: "production",
        });
        expect(updatedTags.Tags).toContainEqual({
          Key: "Team",
          Value: "platform",
        });

        yield* stack.destroy();

        yield* assertDeliveryStreamDeleted(initial.stream.deliveryStreamName);

        // The synthesized IAM role is cleaned up with the stream.
        const roleResult = yield* iam
          .getRole({ RoleName: initial.stream.roleName! })
          .pipe(Effect.result);
        expect(Result.isFailure(roleResult)).toBe(true);
      }),
    { timeout: 300_000 },
  );

  test.provider(
    "replaces the stream when a Kinesis source is added",
    (stack) =>
      Effect.gen(function* () {
        // Keep the bucket AND the kinesis stream deployed across both steps —
        // replacing a resource while simultaneously removing a dependency
        // deadlocks the engine.
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* AWS.S3.Bucket("FirehoseSourceBucket", {
              forceDestroy: true,
            });
            const source = yield* AWS.Kinesis.Stream("FirehoseSourceStream");
            const stream = yield* DeliveryStream("SourcedDeliveryStream", {
              destination: { bucketArn: bucket.bucketArn },
            });
            return { bucket, source, stream };
          }),
        );

        expect(initial.stream.deliveryStreamType).toEqual("DirectPut");

        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* AWS.S3.Bucket("FirehoseSourceBucket", {
              forceDestroy: true,
            });
            const source = yield* AWS.Kinesis.Stream("FirehoseSourceStream");
            const stream = yield* DeliveryStream("SourcedDeliveryStream", {
              source: { kinesisStreamArn: source.streamArn },
              destination: { bucketArn: bucket.bucketArn },
            });
            return { bucket, source, stream };
          }),
        );

        // Source change is a replacement — new physical stream.
        expect(replaced.stream.deliveryStreamName).not.toEqual(
          initial.stream.deliveryStreamName,
        );
        expect(replaced.stream.deliveryStreamType).toEqual(
          "KinesisStreamAsSource",
        );
        expect(replaced.stream.kinesisStreamArn).toEqual(
          replaced.source.streamArn,
        );

        const described = yield* Firehose.describeDeliveryStream({
          DeliveryStreamName: replaced.stream.deliveryStreamName,
        });
        expect(
          described.DeliveryStreamDescription.Source
            ?.KinesisStreamSourceDescription?.KinesisStreamARN,
        ).toEqual(replaced.source.streamArn);

        // The replaced (old) stream is deleted by the engine.
        yield* assertDeliveryStreamDeleted(initial.stream.deliveryStreamName);

        yield* stack.destroy();

        yield* assertDeliveryStreamDeleted(replaced.stream.deliveryStreamName);
      }),
    { timeout: 420_000 },
  );

  class DeliveryStreamStillExists extends Data.TaggedError(
    "DeliveryStreamStillExists",
  ) {}

  const assertDeliveryStreamDeleted = Effect.fn(function* (
    deliveryStreamName: string,
  ) {
    yield* Firehose.describeDeliveryStream({
      DeliveryStreamName: deliveryStreamName,
    }).pipe(
      Effect.flatMap(() => Effect.fail(new DeliveryStreamStillExists())),
      Effect.retry({
        while: (e: { _tag: string }) => e._tag === "DeliveryStreamStillExists",
        schedule: Schedule.fixed("3 seconds").pipe(
          Schedule.both(Schedule.recurs(40)),
        ),
      }),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
  });
});
