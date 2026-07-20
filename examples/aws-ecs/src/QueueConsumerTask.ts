import * as AWS from "alchemy/AWS";
import * as Server from "alchemy/Server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { JobsQueue, JobsQueueLive } from "./JobsQueue.ts";

export default class QueueConsumerTask extends AWS.ECS.Task<QueueConsumerTask>()(
  "QueueConsumerTask",
  {
    main: import.meta.url,
    cpu: 256,
    memory: 512,
    taskRoleManagedPolicyArns: ["arn:aws:iam::aws:policy/AmazonSQSFullAccess"],
  },
  Effect.gen(function* () {
    const queue = yield* JobsQueue;
    yield* AWS.SQS.consumeQueueMessages(
      queue,
      {
        batchSize: 10,
        maximumBatchingWindow: "20 seconds",
      },
      (stream) =>
        stream.pipe(
          Stream.runForEach((record) =>
            Effect.logInfo(
              `processed SQS message ${record.messageId}: ${record.body ?? ""}`,
            ),
          ),
        ),
    );
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(Server.SQSQueueEventSource, JobsQueueLive),
        Layer.mergeAll(
          AWS.SQS.ReceiveMessageHttp,
          AWS.SQS.DeleteMessageBatchHttp,
        ),
      ),
    ),
  ),
) {}
