import * as AWS from "alchemy-effect/AWS";
import * as Server from "alchemy-effect/Server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { JobsQueue } from "./JobsQueue.ts";

export class QueuePollerTask extends AWS.ECS.Task<QueuePollerTask>()(
  "QueuePollerTask",
  {
    main: import.meta.path,
    cpu: 256,
    memory: 512,
    taskRoleManagedPolicyArns: ["arn:aws:iam::aws:policy/AmazonSQSFullAccess"],
    docker: {
      instructions: [["workdir", "/app"] as const],
    },
  },
) {}

export const QueuePollerTaskLive = QueuePollerTask.make(
  // @ts-expect-error
  Effect.gen(function* () {
    const queue = yield* JobsQueue;
    yield* AWS.SQS.messages(queue, {
      batchSize: 10,
      maximumBatchingWindowInSeconds: 20,
    }).subscribe((stream) =>
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
      Layer.mergeAll(
        Server.SQSQueueEventSource,
        AWS.SQS.ReceiveMessageLive,
        AWS.SQS.DeleteMessageBatchLive,
      ),
    ),
  ),
);
