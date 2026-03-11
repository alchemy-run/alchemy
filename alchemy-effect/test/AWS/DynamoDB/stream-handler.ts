import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export const StreamFixture = Effect.gen(function* () {
  const table = yield* AWS.DynamoDB.Table("StreamSourceTable", {
    partitionKey: "pk",
    sortKey: "sk",
    attributes: {
      pk: "S",
      sk: "S",
    },
  });
  const queue = yield* AWS.SQS.Queue("StreamSinkQueue");

  return {
    table,
    queue,
    streamFunction: yield* AWS.Lambda.Function(
      "DynamoDBStreamFunction",
      Effect.gen(function* () {
        const sink = yield* AWS.SQS.QueueSink.bind(queue);

        yield* AWS.DynamoDB.stream(table, {
          streamViewType: "NEW_AND_OLD_IMAGES",
          startingPosition: "LATEST",
          batchSize: 10,
        }).process((stream) =>
          stream.pipe(
            Stream.map((record) =>
              JSON.stringify({
                eventName: record.eventName,
                keys: record.dynamodb.Keys,
                newImage: record.dynamodb.NewImage,
                oldImage: record.dynamodb.OldImage,
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
            Layer.mergeAll(AWS.Lambda.TableEventSource, AWS.SQS.QueueSinkLive),
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
