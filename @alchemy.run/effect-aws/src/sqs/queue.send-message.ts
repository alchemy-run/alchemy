import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { allow, type Allow } from "@alchemy.run/effect";
import type * as Lambda from "../lambda/index.ts";
import { QueueClient } from "./queue.client.ts";
import type { Queue, QueueProps } from "./queue.ts";

export type SendMessage<Q extends Queue = Queue> = Allow<"sqs:SendMessage", Q>;

export const SendMessage = <Q extends Queue>(queue: Q) =>
  ({
    label: `AWS.SQS.SendMessage(${queue.id})`,
    effect: "Allow",
    action: "sqs:SendMessage",
    resource: queue,
    provider: SendMessageBinder,
  }) as const;

export const sendMessage = <Q extends Queue<string, QueueProps>>(
  queue: Q,
  message: Q["props"]["message"]["Type"],
) =>
  Effect.gen(function* () {
    // TODO(sam): we want this to be a phantom and not explicitly in the Requirements
    yield* allow<SendMessage<Q>>();
    const sqs = yield* QueueClient;
    const url =
      process.env[`${queue.id.toUpperCase().replace(/-/g, "_")}_QUEUE_URL`]!;
    return yield* sqs.sendMessage({
      QueueUrl: url,
      MessageBody: JSON.stringify(message),
    });
  });

export class SendMessageBinder extends Context.Tag(
  "AWS::SQS::Queue.SendMessage",
)<SendMessageBinder, Lambda.FunctionBinding<SendMessage<Queue>>>() {}

export const sendMessageBinder = () =>
  Layer.succeed(SendMessageBinder, {
    attach: Effect.fn(function* ({ resource: queue, binding }) {
      return {
        env: {
          [`${queue.id.toUpperCase().replace(/-/g, "_")}_QUEUE_URL`]:
            queue.queueUrl,
        },
        policyStatements: [
          {
            Sid: binding.stmt.sid,
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: [queue.queueArn],
          },
        ],
      };
    }),
  } satisfies Lambda.FunctionBinding<SendMessage<Queue>>);
