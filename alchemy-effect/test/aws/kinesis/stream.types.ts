import { $ } from "@/index";
import * as Kinesis from "@/aws/kinesis";
import * as Lambda from "@/aws/lambda";
import * as SQS from "@/aws/sqs";
import { type } from "@/index";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "..", "..", "handler.ts");

// Define streams and queues for testing
class EventStream extends Kinesis.Stream("EventStream", {
  schema: S.Struct({
    eventId: S.String,
    timestamp: S.Number,
    data: S.Any,
  }),
}) {}

class OutputQueue extends SQS.Queue("OutputQueue", {
  schema: S.String,
}) {}

// ===== Test: consumeStream with putRecord in handler =====
// Should require PutRecord binding when handler uses putRecord

class AnotherStream extends Kinesis.Stream("AnotherStream", {
  schema: S.Struct({
    id: S.String,
  }),
}) {}

const streamForwarder = Lambda.consumeStream("StreamForwarder", {
  stream: EventStream,
  handle: Effect.fn(function* (event) {
    for (const record of event.Records) {
      yield* Kinesis.putRecord(
        AnotherStream,
        { id: record.kinesis.data.eventId },
        { partitionKey: record.kinesis.data.eventId },
      ).pipe(Effect.catchAll(() => Effect.void));
    }
  }),
});

// Valid: has the required PutRecord binding
{
  class StreamForwarder extends streamForwarder({
    main,
    bindings: $(Kinesis.PutRecord(AnotherStream)),
  }) {}
}

// Error: missing PutRecord binding
{
  class StreamForwarder extends streamForwarder({
    main,
    // @ts-expect-error - missing Kinesis.PutRecord(AnotherStream)
    bindings: $(),
  }) {}
}

// Error: wrong stream in PutRecord binding
{
  class StreamForwarder extends streamForwarder({
    main,
    // @ts-expect-error - wrong stream, should be AnotherStream
    bindings: $(Kinesis.PutRecord(EventStream)),
  }) {}
}

// ===== Test: consumeStream with sendMessage in handler =====
// Should require SendMessage binding when handler uses sendMessage

const streamToQueue = Lambda.consumeStream("StreamToQueue", {
  stream: EventStream,
  handle: Effect.fn(function* (event) {
    for (const record of event.Records) {
      yield* SQS.sendMessage(OutputQueue, JSON.stringify(record.kinesis.data)).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }
  }),
});

// Valid: has the required SendMessage binding
{
  class StreamToQueue extends streamToQueue({
    main,
    bindings: $(SQS.SendMessage(OutputQueue)),
  }) {}
}

// Error: missing SendMessage binding
{
  class StreamToQueue extends streamToQueue({
    main,
    // @ts-expect-error - missing SQS.SendMessage(OutputQueue)
    bindings: $(),
  }) {}
}

// ===== Test: consumeStream with multiple bindings =====

const multiBindingConsumer = Lambda.consumeStream("MultiBindingConsumer", {
  stream: EventStream,
  handle: Effect.fn(function* (event) {
    for (const record of event.Records) {
      yield* SQS.sendMessage(OutputQueue, JSON.stringify(record.kinesis.data)).pipe(
        Effect.catchAll(() => Effect.void),
      );
      yield* Kinesis.putRecord(
        AnotherStream,
        { id: record.kinesis.data.eventId },
        { partitionKey: record.kinesis.data.eventId },
      ).pipe(Effect.catchAll(() => Effect.void));
    }
  }),
});

// Valid: has all required bindings
{
  class MultiBindingConsumer extends multiBindingConsumer({
    main,
    bindings: $(SQS.SendMessage(OutputQueue), Kinesis.PutRecord(AnotherStream)),
  }) {}
}

// Error: missing one of the bindings
{
  class MultiBindingConsumer extends multiBindingConsumer({
    main,
    // @ts-expect-error - missing Kinesis.PutRecord(AnotherStream)
    bindings: $(SQS.SendMessage(OutputQueue)),
  }) {}
}

// ===== Test: consumeStream with no additional bindings =====

const simpleConsumer = Lambda.consumeStream("SimpleConsumer", {
  stream: EventStream,
  handle: Effect.fn(function* (event) {
    // Just log, no external calls
    console.log("Received", event.Records.length, "records");
  }),
});

// Valid: no additional bindings needed
{
  class SimpleConsumer extends simpleConsumer({
    main,
    bindings: $(),
  }) {}
}

// Error: unnecessary binding
{
  class SimpleConsumer extends simpleConsumer({
    main,
    // @ts-expect-error - unnecessary SQS.SendMessage binding
    bindings: $(SQS.SendMessage(OutputQueue)),
  }) {}
}

// ===== Test: consumeStream with event source options =====

// consumeStream supports event source configuration
const configuredConsumer = Lambda.consumeStream("ConfiguredConsumer", {
  stream: EventStream,
  batchSize: 50,
  startingPosition: "LATEST",
  parallelizationFactor: 2,
  maximumRetryAttempts: 3,
  bisectBatchOnFunctionError: true,
  handle: Effect.fn(function* (event) {
    console.log("Processing", event.Records.length, "records");
  }),
});

{
  class ConfiguredConsumer extends configuredConsumer({
    main,
    bindings: $(),
  }) {}
}

// ===== Test: putRecords in Lambda serve =====

const batchProducer = Lambda.serve("BatchProducer", {
  fetch: Effect.fn(function* (event) {
    yield* Kinesis.putRecords(EventStream, [
      {
        data: { eventId: "1", timestamp: Date.now(), data: null },
        partitionKey: "pk1",
      },
      {
        data: { eventId: "2", timestamp: Date.now(), data: null },
        partitionKey: "pk2",
      },
    ]).pipe(Effect.catchAll(() => Effect.void));
    return { statusCode: 200, body: "OK" };
  }),
});

// Valid: PutRecord binding covers both putRecord and putRecords
{
  class BatchProducer extends batchProducer({
    main,
    bindings: $(Kinesis.PutRecord(EventStream)),
  }) {}
}

// Error: missing PutRecord binding
{
  class BatchProducer extends batchProducer({
    main,
    // @ts-expect-error - missing Kinesis.PutRecord(EventStream)
    bindings: $(),
  }) {}
}
