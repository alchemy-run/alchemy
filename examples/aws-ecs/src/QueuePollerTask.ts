import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import * as AWS from "alchemy-effect/AWS";
import { ProcessRuntime } from "alchemy-effect/Process/Runtime";
import { SQSQueueEventSource } from "alchemy-effect/Process/SQSQueueEventSource";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const runtime = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer).pipe(
  Layer.provideMerge(Credentials.fromEnv()),
  Layer.provideMerge(Region.fromEnv()),
  Layer.provideMerge(
    Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
  ),
);

const processLayers = (task: any) =>
  Layer.mergeAll(
    Layer.succeed(ProcessRuntime, task),
    SQSQueueEventSource,
    AWS.SQS.ReceiveMessageLive,
    AWS.SQS.DeleteMessageBatchLive,
    AWS.SQS.ReceiveMessagePolicy.layer.succeed(() => Effect.void),
    AWS.SQS.DeleteMessageBatchPolicy.layer.succeed(() => Effect.void),
  ).pipe(Layer.provideMerge(runtime));

export const QueuePollerTask = (queue: AWS.SQS.Queue) =>
  Effect.gen(function* () {
    const task = yield* AWS.ECS.Task.Runtime;
    const subscription = AWS.SQS.messages(queue, {
      batchSize: 10,
      maximumBatchingWindowInSeconds: 20,
    })
      .subscribe((stream) =>
        stream.pipe(
          Stream.runForEach((record) =>
            Effect.logInfo(
              `processed SQS message ${record.messageId}: ${record.body ?? ""}`,
            ),
          ),
        ),
      )
      .pipe(Effect.provide(processLayers(task)), Effect.orDie) as Effect.Effect<
      void,
      never,
      never
    >;

    yield* subscription;

    return {
      main: import.meta.path,
      cpu: 256,
      memory: 512,
      taskRoleManagedPolicyArns: [
        "arn:aws:iam::aws:policy/AmazonSQSFullAccess",
      ],
      docker: {
        instructions: [["workdir", "/app"] as const],
      },
    };
  }).pipe(AWS.ECS.Task("QueuePollerTask"));
