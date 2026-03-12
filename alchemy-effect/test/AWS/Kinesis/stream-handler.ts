import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export const StreamFixture = Effect.gen(function* () {
  const stream = yield* AWS.Kinesis.Stream("EventSourceStream", {
    streamMode: "PROVISIONED",
    shardCount: 1,
  });
  const queue = yield* AWS.SQS.Queue("KinesisEventSinkQueue");

  return {
    stream,
    queue,
    streamFunction: yield* AWS.Lambda.Function(
      "KinesisStreamFunction",
      Effect.gen(function* () {
        const sink = yield* AWS.SQS.QueueSink.bind(queue);

        yield* AWS.Kinesis.records(stream, {
          startingPosition: "LATEST",
          batchSize: 10,
        }).process((records) =>
          records.pipe(
            Stream.map((record) =>
              JSON.stringify({
                partitionKey: record.kinesis.partitionKey,
                data: Buffer.from(record.kinesis.data, "base64").toString(
                  "utf8",
                ),
                eventID: record.eventID,
              }),
            ),
            Stream.run(sink),
          ),
        );

        return {
          main: import.meta.filename,
        } as const satisfies AWS.Lambda.FunctionProps;
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.mergeAll(AWS.Lambda.StreamEventSource, AWS.SQS.QueueSinkLive),
            Layer.mergeAll(AWS.SQS.SendMessageBatchLive),
          ),
        ),
      ),
    ),
  };
});

export default StreamFixture.pipe(
  Effect.map(({ streamFunction }) => streamFunction),
);
