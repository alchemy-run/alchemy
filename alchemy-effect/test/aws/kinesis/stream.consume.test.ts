import { $ } from "@/index";
import * as AWS from "@/aws";
import * as Kinesis from "@/aws/kinesis";
import * as Lambda from "@/aws/lambda";
import * as SQS from "@/aws/sqs";
import { apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as KinesisSDK from "distilled-aws/kinesis";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "..", "..", "handler.ts");

// Test type: consumeStream creates a Lambda function that consumes from a Kinesis stream
// and validates that the types flow correctly
test(
  "consumeStream and putRecord integration",
  { timeout: 300_000 },
  Effect.gen(function* () {
    // Create a Kinesis stream with a typed schema
    class EventStream extends Kinesis.Stream("EventStream", {
      schema: S.Struct({
        eventId: S.String,
        timestamp: S.Number,
        payload: S.String,
      }),
    }) {}

    // Create a dead letter queue to verify handler execution
    class DLQ extends SQS.Queue("DLQ", {
      schema: S.String,
    }) {}

    // Create a Lambda function that consumes from the stream
    class StreamConsumer extends Lambda.consumeStream("StreamConsumer", {
      stream: EventStream,
      handle: Effect.fn(function* (event) {
        // Process each record
        for (const record of event.Records) {
          // Send to DLQ to verify we received the record
          yield* SQS.sendMessage(DLQ, JSON.stringify(record.kinesis.data)).pipe(
            Effect.catchAll(() => Effect.void),
          );
        }
      }),
    })({
      main,
      bindings: $(SQS.SendMessage(DLQ)),
    }) {}

    // Create a Lambda function that produces to the stream
    class StreamProducer extends Lambda.serve("StreamProducer", {
      fetch: Effect.fn(function* (event) {
        yield* Kinesis.putRecord(
          EventStream,
          {
            eventId: "test-123",
            timestamp: Date.now(),
            payload: "Hello from producer",
          },
          { partitionKey: "test-key" },
        );
        return { statusCode: 200, body: "OK" };
      }),
    })({
      main,
      bindings: $(Kinesis.PutRecord(EventStream)),
    }) {}

    // Apply the stack
    const stack = yield* apply(EventStream, DLQ, StreamConsumer, StreamProducer);

    // Verify resources were created
    expect(stack.EventStream.streamArn).toContain("kinesis");
    expect(stack.StreamConsumer.functionArn).toContain("lambda");
    expect(stack.StreamProducer.functionArn).toContain("lambda");

    yield* destroy();

    yield* assertStreamDeleted(stack.EventStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

// Test type: putRecords sends multiple records at once
test(
  "putRecords sends multiple records",
  { timeout: 300_000 },
  Effect.gen(function* () {
    class BatchStream extends Kinesis.Stream("BatchStream", {
      schema: S.Struct({
        id: S.String,
        value: S.Number,
      }),
    }) {}

    class BatchProducer extends Lambda.serve("BatchProducer", {
      fetch: Effect.fn(function* (event) {
        yield* Kinesis.putRecords(BatchStream, [
          { data: { id: "1", value: 100 }, partitionKey: "pk1" },
          { data: { id: "2", value: 200 }, partitionKey: "pk2" },
          { data: { id: "3", value: 300 }, partitionKey: "pk3" },
        ]);
        return { statusCode: 200, body: "OK" };
      }),
    })({
      main,
      bindings: $(Kinesis.PutRecord(BatchStream)),
    }) {}

    const stack = yield* apply(BatchStream, BatchProducer);

    expect(stack.BatchStream.streamArn).toContain("kinesis");
    expect(stack.BatchProducer.functionArn).toContain("lambda");

    yield* destroy();

    yield* assertStreamDeleted(stack.BatchStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

// Test: consumeStream with event source configuration options
test(
  "consumeStream with event source options",
  { timeout: 300_000 },
  Effect.gen(function* () {
    class ConfiguredStream extends Kinesis.Stream("ConfiguredStream", {
      schema: S.Struct({
        message: S.String,
      }),
    }) {}

    class ConfiguredConsumer extends Lambda.consumeStream("ConfiguredConsumer", {
      stream: ConfiguredStream,
      batchSize: 50,
      startingPosition: "LATEST",
      parallelizationFactor: 2,
      maximumRetryAttempts: 3,
      handle: Effect.fn(function* (event) {
        // Process records
        for (const record of event.Records) {
          console.log("Received:", record.kinesis.data);
        }
      }),
    })({
      main,
      bindings: $(),
    }) {}

    const stack = yield* apply(ConfiguredStream, ConfiguredConsumer);

    expect(stack.ConfiguredStream.streamArn).toContain("kinesis");
    expect(stack.ConfiguredConsumer.functionArn).toContain("lambda");

    yield* destroy();

    yield* assertStreamDeleted(stack.ConfiguredStream.streamName);
  }).pipe(Effect.provide(AWS.providers())),
);

class StreamStillExists extends Data.TaggedError("StreamStillExists") {}

const assertStreamDeleted = Effect.fn(function* (streamName: string) {
  yield* KinesisSDK.describeStreamSummary({
    StreamName: streamName,
  }).pipe(
    Effect.flatMap(() => Effect.fail(new StreamStillExists())),
    Effect.retry({
      while: (e) =>
        e._tag === "StreamStillExists" ||
        e._tag === "ParseError",
      schedule: Schedule.exponential(500).pipe(
        Schedule.intersect(Schedule.recurs(30)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});
