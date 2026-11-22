import * as AWS from "@alchemy.run/aws";
import { SQSQueueEventSource } from "@alchemy.run/aws/Server/SQSQueueEventSource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const SourceQueue = AWS.SQS.Queue("ServerEventSourceQueue");
export const SinkQueue = AWS.SQS.Queue("ServerEventSourceSink");

// An ECS consumer with Lambda-sized batch settings: batches of 100 and a
// 60-second batching window. SQS's ReceiveMessage returns at most 10 messages
// and waits at most 20 seconds, so the server loop must cap both.
export default class ServerQueueTask extends AWS.ECS.Task<ServerQueueTask>()(
  "SQSServerQueueTask",
  {
    main: import.meta.filename,
    image: "oven/bun:1",
    cpu: 256,
    memory: 512,
    container: {
      linuxParameters: { initProcessEnabled: true },
      stopTimeout: 2,
    },
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
  },
  Effect.gen(function* () {
    const source = yield* SourceQueue;
    const sink = yield* SinkQueue;
    const sendMessage = yield* AWS.SQS.SendMessage(sink);

    yield* AWS.SQS.consumeQueueMessages(
      source,
      { batchSize: 100, maximumBatchingWindow: "60 seconds" },
      Effect.fn(function* (event) {
        yield* Effect.forEach(event.Records, (record) =>
          sendMessage({ MessageBody: record.body }).pipe(Effect.orDie),
        );
      }),
    );

    return { run: Effect.never };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SQSQueueEventSource.pipe(
          Layer.provide(Layer.mergeAll(AWS.SQS.ReceiveMessageHttp, AWS.SQS.DeleteMessageBatchHttp)),
        ),
        AWS.SQS.SendMessageHttp,
      ),
    ),
  ),
) {}
