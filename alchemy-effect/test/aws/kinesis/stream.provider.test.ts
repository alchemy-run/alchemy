import * as AWS from "@/aws";
import { Stream } from "@/aws/kinesis";
import { apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as Kinesis from "distilled-aws/kinesis";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

test(
  "create, update, delete on-demand stream with tags",
  { timeout: 180_000 },
  Effect.gen(function* () {
    class TestStream extends Stream("TestStream", {
      schema: S.Struct({
        eventId: S.String,
        data: S.String,
      }),
      streamMode: "ON_DEMAND",
      tags: { Environment: "test" },
    }) {}

    const stack = yield* apply(TestStream);

    // Verify the stream was created
    const streamDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.TestStream.streamName,
    });
    expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
      "ACTIVE",
    );
    expect(
      streamDescription.StreamDescriptionSummary.StreamModeDetails?.StreamMode,
    ).toEqual("ON_DEMAND");
    expect(
      streamDescription.StreamDescriptionSummary.RetentionPeriodHours,
    ).toEqual(24);

    // Verify tags
    const tagging = yield* Kinesis.listTagsForStream({
      StreamName: stack.TestStream.streamName,
    });
    expect(tagging.Tags).toContainEqual({
      Key: "Environment",
      Value: "test",
    });

    // Update the stream - increase retention period and update tags
    class UpdatedStream extends Stream("TestStream", {
      schema: S.Struct({
        eventId: S.String,
        data: S.String,
      }),
      streamMode: "ON_DEMAND",
      retentionPeriodHours: 48,
      tags: { Environment: "production", Team: "platform" },
    }) {}

    yield* apply(UpdatedStream);

    // Verify the retention period was updated
    const updatedDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.TestStream.streamName,
    });
    expect(
      updatedDescription.StreamDescriptionSummary.RetentionPeriodHours,
    ).toEqual(48);

    // Verify tags were updated
    const updatedTagging = yield* Kinesis.listTagsForStream({
      StreamName: stack.TestStream.streamName,
    });
    expect(updatedTagging.Tags).toContainEqual({
      Key: "Environment",
      Value: "production",
    });
    expect(updatedTagging.Tags).toContainEqual({
      Key: "Team",
      Value: "platform",
    });

    yield* destroy();

    yield* assertStreamDeleted(stack.TestStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create provisioned stream with shards",
  { timeout: 180_000 },
  Effect.gen(function* () {
    class ProvisionedStream extends Stream("ProvisionedStream", {
      schema: S.Struct({
        key: S.String,
        value: S.Number,
      }),
      streamMode: "PROVISIONED",
      shardCount: 2,
    }) {}

    const stack = yield* apply(ProvisionedStream);

    // Verify the stream was created with shards
    const streamDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.ProvisionedStream.streamName,
    });
    expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
      "ACTIVE",
    );
    expect(
      streamDescription.StreamDescriptionSummary.StreamModeDetails?.StreamMode,
    ).toEqual("PROVISIONED");
    expect(streamDescription.StreamDescriptionSummary.OpenShardCount).toEqual(
      2,
    );

    yield* destroy();

    yield* assertStreamDeleted(stack.ProvisionedStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "update provisioned stream shard count",
  { timeout: 300_000 },
  Effect.gen(function* () {
    class ShardStream extends Stream("ShardStream", {
      schema: S.Struct({
        data: S.String,
      }),
      streamMode: "PROVISIONED",
      shardCount: 1,
    }) {}

    const stack = yield* apply(ShardStream);

    // Verify initial shard count
    const streamDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.ShardStream.streamName,
    });
    expect(streamDescription.StreamDescriptionSummary.OpenShardCount).toEqual(
      1,
    );

    // Update shard count
    class UpdatedShardStream extends Stream("ShardStream", {
      schema: S.Struct({
        data: S.String,
      }),
      streamMode: "PROVISIONED",
      shardCount: 2,
    }) {}

    yield* apply(UpdatedShardStream);

    // Verify shard count was updated
    const updatedDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.ShardStream.streamName,
    });
    expect(updatedDescription.StreamDescriptionSummary.OpenShardCount).toEqual(
      2,
    );

    yield* destroy();

    yield* assertStreamDeleted(stack.ShardStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create stream with custom name",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const customName = `test-custom-kinesis-stream-${Date.now()}`;

    class CustomNameStream extends Stream("CustomNameStream", {
      schema: S.Struct({
        message: S.String,
      }),
      streamName: customName,
    }) {}

    const stack = yield* apply(CustomNameStream);

    expect(stack.CustomNameStream.streamName).toEqual(customName);
    expect(stack.CustomNameStream.streamArn).toContain(customName);

    // Verify the stream exists
    const streamDescription = yield* Kinesis.describeStreamSummary({
      StreamName: customName,
    });
    expect(streamDescription.StreamDescriptionSummary.StreamName).toEqual(
      customName,
    );

    yield* destroy();

    yield* assertStreamDeleted(customName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create stream with encryption",
  { timeout: 180_000 },
  Effect.gen(function* () {
    class EncryptedStream extends Stream("EncryptedStream", {
      schema: S.Struct({
        sensitiveData: S.String,
      }),
      encryption: true,
    }) {}

    const stack = yield* apply(EncryptedStream);

    // Verify the stream has encryption enabled
    const streamDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.EncryptedStream.streamName,
    });
    expect(streamDescription.StreamDescriptionSummary.EncryptionType).toEqual(
      "KMS",
    );

    // Update to disable encryption
    class UnencryptedStream extends Stream("EncryptedStream", {
      schema: S.Struct({
        sensitiveData: S.String,
      }),
      encryption: false,
    }) {}

    yield* apply(UnencryptedStream);

    // Verify encryption is disabled
    const updatedDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.EncryptedStream.streamName,
    });
    expect(updatedDescription.StreamDescriptionSummary.EncryptionType).toEqual(
      "NONE",
    );

    yield* destroy();

    yield* assertStreamDeleted(stack.EncryptedStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create stream with enhanced monitoring and update metrics",
  { timeout: 180_000 },
  Effect.gen(function* () {
    class MonitoredStream extends Stream("MonitoredStream", {
      schema: S.Struct({
        event: S.String,
      }),
      shardLevelMetrics: ["IncomingBytes", "OutgoingRecords"],
    }) {}

    const stack = yield* apply(MonitoredStream);

    // Verify enhanced monitoring is enabled
    const streamDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.MonitoredStream.streamName,
    });
    const metrics =
      streamDescription.StreamDescriptionSummary.EnhancedMonitoring?.[0]
        ?.ShardLevelMetrics ?? [];
    expect(metrics).toContain("IncomingBytes");
    expect(metrics).toContain("OutgoingRecords");

    // Update metrics - add some, remove some
    class UpdatedMonitoredStream extends Stream("MonitoredStream", {
      schema: S.Struct({
        event: S.String,
      }),
      shardLevelMetrics: [
        "IncomingBytes",
        "IncomingRecords",
        "IteratorAgeMilliseconds",
      ],
    }) {}

    yield* apply(UpdatedMonitoredStream);

    // Verify metrics were updated
    const updatedDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.MonitoredStream.streamName,
    });
    const updatedMetrics =
      updatedDescription.StreamDescriptionSummary.EnhancedMonitoring?.[0]
        ?.ShardLevelMetrics ?? [];
    expect(updatedMetrics).toContain("IncomingBytes");
    expect(updatedMetrics).toContain("IncomingRecords");
    expect(updatedMetrics).toContain("IteratorAgeMilliseconds");
    expect(updatedMetrics).not.toContain("OutgoingRecords");

    yield* destroy();

    yield* assertStreamDeleted(stack.MonitoredStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "idempotent create - stream already exists",
  { timeout: 180_000 },
  Effect.gen(function* () {
    class IdempotentStream extends Stream("IdempotentStream", {
      schema: S.Struct({
        data: S.String,
      }),
    }) {}

    // First create
    const stack1 = yield* apply(IdempotentStream);
    const streamName = stack1.IdempotentStream.streamName;

    // Second create (should be idempotent)
    const stack2 = yield* apply(IdempotentStream);
    expect(stack2.IdempotentStream.streamName).toEqual(streamName);

    yield* destroy();

    yield* assertStreamDeleted(streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "switch stream mode from provisioned to on-demand",
  { timeout: 300_000 },
  Effect.gen(function* () {
    class ModeChangeStream extends Stream("ModeChangeStream", {
      schema: S.Struct({
        data: S.String,
      }),
      streamMode: "PROVISIONED",
      shardCount: 1,
    }) {}

    const stack = yield* apply(ModeChangeStream);

    // Verify provisioned mode
    const streamDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.ModeChangeStream.streamName,
    });
    expect(
      streamDescription.StreamDescriptionSummary.StreamModeDetails?.StreamMode,
    ).toEqual("PROVISIONED");

    // Update to on-demand mode
    class OnDemandStream extends Stream("ModeChangeStream", {
      schema: S.Struct({
        data: S.String,
      }),
      streamMode: "ON_DEMAND",
    }) {}

    yield* apply(OnDemandStream);

    // Verify on-demand mode
    const updatedDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.ModeChangeStream.streamName,
    });
    expect(
      updatedDescription.StreamDescriptionSummary.StreamModeDetails?.StreamMode,
    ).toEqual("ON_DEMAND");

    yield* destroy();

    yield* assertStreamDeleted(stack.ModeChangeStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "decrease retention period",
  { timeout: 180_000 },
  Effect.gen(function* () {
    class RetentionStream extends Stream("RetentionStream", {
      schema: S.Struct({
        data: S.String,
      }),
      retentionPeriodHours: 48,
    }) {}

    const stack = yield* apply(RetentionStream);

    // Verify initial retention period
    const streamDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.RetentionStream.streamName,
    });
    expect(
      streamDescription.StreamDescriptionSummary.RetentionPeriodHours,
    ).toEqual(48);

    // Decrease retention period back to default
    class UpdatedRetentionStream extends Stream("RetentionStream", {
      schema: S.Struct({
        data: S.String,
      }),
      retentionPeriodHours: 24,
    }) {}

    yield* apply(UpdatedRetentionStream);

    // Verify retention period was decreased
    const updatedDescription = yield* Kinesis.describeStreamSummary({
      StreamName: stack.RetentionStream.streamName,
    });
    expect(
      updatedDescription.StreamDescriptionSummary.RetentionPeriodHours,
    ).toEqual(24);

    yield* destroy();

    yield* assertStreamDeleted(stack.RetentionStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

class StreamStillExists extends Data.TaggedError("StreamStillExists") {}

const assertStreamDeleted = Effect.fn(function* (streamName: string) {
  yield* Kinesis.describeStreamSummary({
    StreamName: streamName,
  }).pipe(
    Effect.flatMap(() => Effect.fail(new StreamStillExists())),
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "StreamStillExists" ||
        // During stream deletion, AWS may return incomplete responses that fail parsing
        e._tag === "ParseError",
      schedule: Schedule.exponential(500).pipe(
        Schedule.intersect(Schedule.recurs(30)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});
